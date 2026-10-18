import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { authenticate, normalizeAgencyRole } from "../auth/auth.plugin.js";
import { disabledPermissionList, isAgencyTogglable } from "../auth/permissions.js";
import { hashToken, issueSession } from "../auth/session.js";

// Camada de agência (estilo GHL): a conta master (agency_admin) enxerga e
// gerencia todas as contas; agency_user só entra nas contas liberadas pra
// ele. Os usuários de agência vivem na conta de origem da agência.

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

const paramsSchema = z.object({ id: z.string().min(1) });

const createAccountSchema = z.object({
  name: z.string().trim().min(1, "Nome da conta é obrigatório"),
  adminName: z.string().trim().min(1, "Nome do admin é obrigatório"),
  adminEmail: z.string().trim().email("E-mail do admin inválido"),
  adminPassword: z.string().min(6, "Senha precisa ter pelo menos 6 caracteres"),
});

const updateAccountSchema = z.object({
  name: z.string().trim().min(1).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  disabledPermissions: z
    .array(z.string())
    .refine((keys) => keys.every(isAgencyTogglable), { message: "Módulo desconhecido" })
    .optional(),
});

const agencyRoleSchema = z.enum(["agency_admin", "agency_user"]);

const createAgencyUserSchema = z.object({
  name: z.string().trim().min(1, "Nome é obrigatório"),
  email: z.string().trim().email("E-mail inválido"),
  password: z.string().min(6, "Senha precisa ter pelo menos 6 caracteres"),
  agencyRole: agencyRoleSchema.default("agency_user"),
  tenantIds: z.array(z.string()).default([]),
});

const updateAgencyUserSchema = z.object({
  name: z.string().trim().min(1).optional(),
  password: z.string().min(6, "Senha precisa ter pelo menos 6 caracteres").optional(),
  agencyRole: agencyRoleSchema.optional(),
  active: z.boolean().optional(),
  tenantIds: z.array(z.string()).optional(),
});

const enterSchema = z.object({ refreshToken: z.string().optional() });

async function requireAgency(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth.agencyRole) {
    return reply.status(403).send({ error: "Acesso restrito à agência" });
  }
}

async function requireAgencyAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.auth.agencyRole !== "agency_admin") {
    return reply.status(403).send({ error: "Só o administrador da agência pode fazer isso" });
  }
}

function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "conta";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; ; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await prisma.tenant.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
}

// Contas visíveis pro usuário de agência: todas (agency_admin) ou as
// liberadas + a própria (agency_user).
function accountScope(request: FastifyRequest): Prisma.TenantWhereInput {
  if (request.auth.agencyRole === "agency_admin") return {};
  return {
    OR: [{ id: request.auth.homeTenantId }, { agencyAccess: { some: { userId: request.auth.sub } } }],
  };
}

async function serializeAccounts(where: Prisma.TenantWhereInput, homeTenantId: string) {
  const tenants = await prisma.tenant.findMany({
    where,
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { users: true, conversations: true, contacts: true } },
      whatsappAccounts: {
        select: { provider: true, displayPhoneNumber: true, baileysStatus: true },
        take: 1,
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  return tenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    createdAt: t.createdAt,
    isHome: t.id === homeTenantId,
    disabledPermissions: disabledPermissionList(t.disabledPermissions),
    counts: { users: t._count.users, conversations: t._count.conversations, contacts: t._count.contacts },
    whatsapp: t.whatsappAccounts[0] ?? null,
  }));
}

function serializeAgencyUser(user: {
  id: string;
  name: string;
  email: string;
  active: boolean;
  agencyRole: string | null;
  createdAt: Date;
  agencyAccess: { tenantId: string }[];
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    active: user.active,
    agencyRole: normalizeAgencyRole(user.agencyRole),
    createdAt: user.createdAt,
    tenantIds: user.agencyAccess.map((a) => a.tenantId),
  };
}

// Só contas que existem e não são a de origem da agência (lá eles já
// estão por padrão).
async function validTenantIds(ids: string[], homeTenantId: string): Promise<string[]> {
  const unique = [...new Set(ids)].filter((id) => id !== homeTenantId);
  if (unique.length === 0) return [];
  const found = await prisma.tenant.findMany({ where: { id: { in: unique } }, select: { id: true } });
  return found.map((t) => t.id);
}

export async function agencyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireAgency);

  app.get("/agency/accounts", async (request, reply) => {
    return reply.send(await serializeAccounts(accountScope(request), request.auth.homeTenantId));
  });

  app.post("/agency/accounts", { preHandler: requireAgencyAdmin }, async (request, reply) => {
    const parsed = createAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const { name, adminName, adminEmail, adminPassword } = parsed.data;

    // Login é só e-mail+senha (sem escolher conta), então e-mail é único
    // no sistema inteiro — ver users.routes.ts.
    if (await prisma.user.findFirst({ where: { email: adminEmail }, select: { id: true } })) {
      return reply.status(409).send({ error: "Já existe um usuário com esse e-mail" });
    }

    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const slug = await uniqueSlug(name);
    const tenant = await prisma.tenant.create({
      data: {
        name,
        slug,
        users: { create: { name: adminName, email: adminEmail, passwordHash, role: "admin" } },
      },
    });

    const [account] = await serializeAccounts({ id: tenant.id }, request.auth.homeTenantId);
    return reply.status(201).send(account);
  });

  app.patch("/agency/accounts/:id", { preHandler: requireAgencyAdmin }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = updateAccountSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: params.data.id }, select: { id: true } });
    if (!tenant) {
      return reply.status(404).send({ error: "Conta não encontrada" });
    }
    if (tenant.id === request.auth.homeTenantId && body.data.status === "suspended") {
      return reply.status(409).send({ error: "A conta da agência não pode ser suspensa" });
    }

    const { name, status, disabledPermissions } = body.data;
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(disabledPermissions !== undefined
          ? { disabledPermissions: [...new Set(disabledPermissions)] as Prisma.InputJsonValue }
          : {}),
      },
    });

    const [account] = await serializeAccounts({ id: tenant.id }, request.auth.homeTenantId);
    return reply.send(account);
  });

  // Troca a sessão pra outra conta (ou de volta pra de origem): devolve
  // tokens novos escopados nela. O frontend troca os tokens e recarrega.
  app.post("/agency/accounts/:id/enter", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = enterSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const session = await issueSession(request.auth.sub, params.data.id);
    if (!session.ok) {
      return reply.status(403).send({ error: session.error });
    }

    // A sessão anterior (refresh token da outra conta) deixa de valer.
    if (body.data.refreshToken) {
      await prisma.refreshToken
        .updateMany({
          where: { tokenHash: hashToken(body.data.refreshToken), userId: request.auth.sub, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        .catch(() => {});
    }

    return reply.send(session.body);
  });

  app.get("/agency/users", { preHandler: requireAgencyAdmin }, async (request, reply) => {
    const users = await prisma.user.findMany({
      where: { tenantId: request.auth.homeTenantId, agencyRole: { not: null } },
      orderBy: { name: "asc" },
      include: { agencyAccess: { select: { tenantId: true } } },
    });
    return reply.send(users.map(serializeAgencyUser));
  });

  app.post("/agency/users", { preHandler: requireAgencyAdmin }, async (request, reply) => {
    const parsed = createAgencyUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const { name, email, password, agencyRole, tenantIds } = parsed.data;

    if (await prisma.user.findFirst({ where: { email }, select: { id: true } })) {
      return reply.status(409).send({ error: "Já existe um usuário com esse e-mail" });
    }

    const ids = agencyRole === "agency_user" ? await validTenantIds(tenantIds, request.auth.homeTenantId) : [];
    const user = await prisma.user.create({
      data: {
        tenantId: request.auth.homeTenantId,
        name,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        // Na conta da própria agência entra como usuário comum (o master
        // ajusta na tela de equipe); nas contas de cliente o acesso vem do
        // agencyRole, sempre com os padrões de admin.
        role: agencyRole === "agency_admin" ? "admin" : "user",
        agencyRole,
        agencyAccess: { create: ids.map((tenantId) => ({ tenantId })) },
      },
      include: { agencyAccess: { select: { tenantId: true } } },
    });
    return reply.status(201).send(serializeAgencyUser(user));
  });

  app.patch("/agency/users/:id", { preHandler: requireAgencyAdmin }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = updateAgencyUserSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const existing = await prisma.user.findFirst({
      where: { id: params.data.id, tenantId: request.auth.homeTenantId, agencyRole: { not: null } },
    });
    if (!existing) {
      return reply.status(404).send({ error: "Usuário da agência não encontrado" });
    }

    const { name, password, agencyRole, active, tenantIds } = body.data;
    const isSelf = existing.id === request.auth.sub;
    if (isSelf && agencyRole === "agency_user") {
      return reply.status(409).send({ error: "Você não pode remover seu próprio acesso de administrador da agência" });
    }
    if (isSelf && active === false) {
      return reply.status(409).send({ error: "Você não pode desativar sua própria conta" });
    }

    const finalRole = agencyRole ?? normalizeAgencyRole(existing.agencyRole);
    const ids =
      tenantIds !== undefined && finalRole === "agency_user"
        ? await validTenantIds(tenantIds, request.auth.homeTenantId)
        : undefined;

    const user = await prisma.$transaction(async (tx) => {
      if (ids !== undefined || finalRole === "agency_admin") {
        await tx.agencyUserAccess.deleteMany({ where: { userId: existing.id } });
      }
      if (ids !== undefined && ids.length > 0) {
        await tx.agencyUserAccess.createMany({ data: ids.map((tenantId) => ({ userId: existing.id, tenantId })) });
      }
      return tx.user.update({
        where: { id: existing.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(agencyRole !== undefined ? { agencyRole } : {}),
          ...(active !== undefined ? { active } : {}),
          ...(password !== undefined ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
        },
        include: { agencyAccess: { select: { tenantId: true } } },
      });
    });

    if (active === false) {
      await prisma.refreshToken.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return reply.send(serializeAgencyUser(user));
  });
}

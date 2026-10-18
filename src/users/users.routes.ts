import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { authenticate, requirePermission } from "../auth/auth.plugin.js";
import { compactOverrides, isPermissionKey, normalizeRole, resolvePermissions } from "../auth/permissions.js";

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

const paramsSchema = z.object({ id: z.string().min(1) });

// "agent" ainda é aceito na entrada por compatibilidade — vira "user".
const roleSchema = z
  .enum(["admin", "user", "agent"])
  .transform((r) => (r === "agent" ? "user" : r));

const permissionsSchema = z
  .record(z.string(), z.boolean())
  .refine((obj) => Object.keys(obj).every(isPermissionKey), { message: "Permissão desconhecida" });

const createUserSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  email: z.string().email("E-mail inválido"),
  password: z.string().min(6, "Senha precisa ter pelo menos 6 caracteres"),
  role: roleSchema.default("user"),
  permissions: permissionsSchema.optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: roleSchema.optional(),
  password: z.string().min(6, "Senha precisa ter pelo menos 6 caracteres").optional(),
  // Valores completos (ou parciais) das chaves; o servidor guarda só o que
  // difere do padrão do papel.
  permissions: permissionsSchema.optional(),
});

const updateStatusSchema = z.object({ active: z.boolean() });

function serializeUser(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: Date;
  permissions: unknown;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: normalizeRole(user.role),
    active: user.active,
    createdAt: user.createdAt,
    permissions: [...resolvePermissions(user.role, user.permissions)],
  };
}

async function countOtherActiveAdmins(tenantId: string, exceptUserId: string) {
  return prisma.user.count({ where: { tenantId, role: "admin", active: true, id: { not: exceptUserId } } });
}

export async function usersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Qualquer usuário pode listar — é usado no seletor de "atribuir a" das
  // conversas, não só na tela de gestão de equipe.
  app.get("/users", async (request, reply) => {
    const users = await prisma.user.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { name: "asc" },
    });
    return reply.send(users.map(serializeUser));
  });

  app.post("/users", { preHandler: requirePermission("users.manage") }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const { name, email, password, role, permissions } = parsed.data;

    // E-mail é único globalmente na prática: o login (auth.routes.ts) não
    // pede tenant, só e-mail+senha, então dois tenants com o mesmo e-mail
    // tornariam o login ambíguo — o schema permite (@@unique([tenantId,
    // email])) mas a aplicação não suporta, então barramos aqui.
    const existing = await prisma.user.findFirst({ where: { email } });
    if (existing) {
      return reply.status(409).send({ error: "Já existe um usuário com esse e-mail" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        tenantId: request.auth.tenantId,
        name,
        email,
        passwordHash,
        role,
        permissions: compactOverrides(role, permissions ?? {}) as Prisma.InputJsonValue,
      },
    });

    return reply.status(201).send(serializeUser(user));
  });

  app.patch("/users/:id", { preHandler: requirePermission("users.manage") }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = updateUserSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const existing = await prisma.user.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
    });
    if (!existing) {
      return reply.status(404).send({ error: "Usuário não encontrado" });
    }

    // Usuários de agência são geridos na tela da agência — o admin de uma
    // conta não pode rebaixar nem desativar o master.
    if (existing.agencyRole && request.auth.agencyRole !== "agency_admin") {
      return reply.status(403).send({ error: "Esse usuário é da agência — só o administrador da agência pode alterá-lo" });
    }

    const { name, role, password, permissions } = body.data;

    // A conta nunca pode ficar sem um admin ativo pra gerenciar a equipe.
    if (role === "user" && existing.role === "admin") {
      if (existing.id === request.auth.sub) {
        return reply.status(409).send({ error: "Você não pode remover seu próprio papel de admin" });
      }
      if ((await countOtherActiveAdmins(existing.tenantId, existing.id)) === 0) {
        return reply.status(409).send({ error: "A conta precisa de pelo menos um admin ativo" });
      }
    }

    const finalRole = role ?? existing.role;
    // Ao trocar de papel sem mandar permissões, volta pros padrões do papel
    // novo — as exceções antigas eram relativas ao papel anterior.
    const nextOverrides =
      permissions !== undefined
        ? compactOverrides(finalRole, {
            ...Object.fromEntries([...resolvePermissions(existing.role, existing.permissions)].map((k) => [k, true])),
            ...permissions,
          })
        : role !== undefined && normalizeRole(role) !== normalizeRole(existing.role)
          ? {}
          : undefined;

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(nextOverrides !== undefined ? { permissions: nextOverrides as Prisma.InputJsonValue } : {}),
        ...(password !== undefined ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
      },
    });

    return reply.send(serializeUser(user));
  });

  app.patch("/users/:id/status", { preHandler: requirePermission("users.manage") }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = updateStatusSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    if (params.data.id === request.auth.sub && !body.data.active) {
      return reply.status(409).send({ error: "Você não pode desativar sua própria conta" });
    }

    const existing = await prisma.user.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
    });
    if (!existing) {
      return reply.status(404).send({ error: "Usuário não encontrado" });
    }

    // Usuários de agência são geridos na tela da agência — o admin de uma
    // conta não pode rebaixar nem desativar o master.
    if (existing.agencyRole && request.auth.agencyRole !== "agency_admin") {
      return reply.status(403).send({ error: "Esse usuário é da agência — só o administrador da agência pode alterá-lo" });
    }

    if (!body.data.active && existing.role === "admin" && (await countOtherActiveAdmins(existing.tenantId, existing.id)) === 0) {
      return reply.status(409).send({ error: "A conta precisa de pelo menos um admin ativo" });
    }

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { active: body.data.active },
    });

    // Desativado perde também as sessões abertas (refresh tokens) — o
    // access token já é recusado na hora pelo authenticate.
    if (!body.data.active) {
      await prisma.refreshToken.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return reply.send(serializeUser(user));
  });
}

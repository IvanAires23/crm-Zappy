import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate, requireRole } from "../auth/auth.plugin.js";

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

const paramsSchema = z.object({ id: z.string().min(1) });

const createUserSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  email: z.string().email("E-mail inválido"),
  password: z.string().min(6, "Senha precisa ter pelo menos 6 caracteres"),
  role: z.enum(["admin", "agent"]).default("agent"),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(["admin", "agent"]).optional(),
  password: z.string().min(6, "Senha precisa ter pelo menos 6 caracteres").optional(),
});

const updateStatusSchema = z.object({ active: z.boolean() });

function serializeUser(user: { id: string; name: string; email: string; role: string; active: boolean; createdAt: Date }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, createdAt: user.createdAt };
}

export async function usersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Qualquer papel pode listar — é usado no seletor de "atribuir a" das
  // conversas, não só na tela de gestão de equipe (essa sim é admin-only).
  app.get("/users", async (request, reply) => {
    const users = await prisma.user.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { name: "asc" },
    });
    return reply.send(users.map(serializeUser));
  });

  app.post("/users", { preHandler: requireRole("admin") }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const { name, email, password, role } = parsed.data;

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
      data: { tenantId: request.auth.tenantId, name, email, passwordHash, role },
    });

    return reply.status(201).send(serializeUser(user));
  });

  app.patch("/users/:id", { preHandler: requireRole("admin") }, async (request, reply) => {
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

    // Evita o admin se rebaixar sozinho e ficar sem ninguém pra gerenciar
    // a equipe — teria que pedir pra outro admin fazer isso.
    if (existing.id === request.auth.sub && body.data.role === "agent") {
      return reply.status(409).send({ error: "Você não pode remover seu próprio papel de admin" });
    }

    const { name, role, password } = body.data;
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(password !== undefined ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
      },
    });

    return reply.send(serializeUser(user));
  });

  app.patch("/users/:id/status", { preHandler: requireRole("admin") }, async (request, reply) => {
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

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { active: body.data.active },
    });

    return reply.send(serializeUser(user));
  });
}

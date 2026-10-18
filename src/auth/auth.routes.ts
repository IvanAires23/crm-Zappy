import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "./auth.plugin.js";
import { PERMISSIONS, disabledPermissionList } from "./permissions.js";
import { hashToken, issueSession, sessionUser } from "./session.js";

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/auth/login",
    // Mais rígido que o limite global (server.ts) — dificulta força bruta
    // de senha sem incomodar uso normal (poucas tentativas por minuto).
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: firstZodMessage(parsed.error) });
      }
      const { email, password } = parsed.data;

      const user = await prisma.user.findFirst({ where: { email } });
      if (!user) {
        return reply.status(401).send({ error: "Credenciais inválidas" });
      }
      if (!user.active) {
        return reply.status(403).send({ error: "Usuário desativado — fale com um administrador" });
      }

      const passwordOk = await bcrypt.compare(password, user.passwordHash);
      if (!passwordOk) {
        return reply.status(401).send({ error: "Credenciais inválidas" });
      }

      // Aproveita o login pra limpar tokens já expirados/revogados desse
      // usuário — sem um cron dedicado, a tabela ficaria só crescendo.
      await prisma.refreshToken
        .deleteMany({
          where: { userId: user.id, OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }] },
        })
        .catch(() => {});

      const session = await issueSession(user.id, user.tenantId);
      if (!session.ok) {
        return reply.status(403).send({ error: session.error });
      }
      return reply.send(session.body);
    }
  );

  // Troca um refresh token válido por um access token novo — e por um
  // refresh token novo também (rotação: o antigo é revogado na hora, então
  // um refresh token vazado só serve até a próxima renovação legítima).
  app.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }

    const tokenHash = hashToken(parsed.data.refreshToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date() || !stored.user.active) {
      return reply.status(401).send({ error: "Sessão expirada — faça login de novo" });
    }

    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });

    // Se o acesso à conta em que ele estava foi retirado, volta pra de origem.
    let session = await issueSession(stored.user.id, stored.actingTenantId ?? stored.user.tenantId);
    if (!session.ok && stored.actingTenantId) {
      session = await issueSession(stored.user.id, stored.user.tenantId);
    }
    if (!session.ok) {
      return reply.status(401).send({ error: session.error });
    }
    return reply.send(session.body);
  });

  // Revoga o refresh token no logout — sem isso, um token capturado antes
  // do logout continuaria podendo renovar a sessão por até 30 dias.
  app.post("/auth/logout", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (parsed.success) {
      await prisma.refreshToken
        .updateMany({
          where: { tokenHash: hashToken(parsed.data.refreshToken), revokedAt: null },
          data: { revokedAt: new Date() },
        })
        .catch(() => {});
    }
    return reply.status(204).send();
  });

  app.get("/auth/me", { preHandler: authenticate }, async (request, reply) => {
    return reply.send(await sessionUser(request.auth));
  });

  // Catálogo de permissões pra tela de equipe desenhar as chaves. Módulos
  // que a agência desligou nesta conta vêm marcados — o admin da conta vê,
  // mas não consegue ligar.
  app.get("/auth/permissions", { preHandler: authenticate }, async (request, reply) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: request.auth.tenantId },
      select: { disabledPermissions: true },
    });
    const disabled = new Set(disabledPermissionList(tenant?.disabledPermissions));
    return reply.send(PERMISSIONS.map((p) => (disabled.has(p.key) ? { ...p, disabledByAgency: true } : p)));
  });
}

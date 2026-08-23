import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { authenticate } from "./auth.plugin.js";

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signAccessToken(user: { id: string; tenantId: string; role: string }): string {
  // Curto de propósito — a longevidade da sessão agora vem do refresh
  // token (30 dias), não do access token. Sem isso um token vazado/roubado
  // continuaria válido por horas; agora só por até 1h.
  return jwt.sign({ sub: user.id, tenantId: user.tenantId, role: user.role }, env.JWT_SECRET, {
    expiresIn: "1h",
  });
}

async function issueRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return token;
}

function serializeUser(user: { id: string; name: string; email: string; role: string; tenantId: string }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId };
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

      const token = signAccessToken(user);
      const refreshToken = await issueRefreshToken(user.id);

      return reply.send({ token, refreshToken, user: serializeUser(user) });
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

    const token = signAccessToken(stored.user);
    const refreshToken = await issueRefreshToken(stored.user.id);

    return reply.send({ token, refreshToken, user: serializeUser(stored.user) });
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
    const user = await prisma.user.findUnique({ where: { id: request.auth.sub } });
    if (!user) {
      return reply.status(404).send({ error: "Usuário não encontrado" });
    }
    return reply.send(serializeUser(user));
  });
}

import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { resolvePermissions } from "./permissions.js";

export interface AuthPayload {
  sub: string;
  tenantId: string;
  role: string;
}

export interface RequestAuth extends AuthPayload {
  permissions: Set<string>;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: RequestAuth;
  }
}

// O papel e as permissões vêm do banco a cada request, não do JWT: assim
// desativar um usuário ou mudar as permissões dele vale na hora, sem
// esperar o access token (1h) expirar.
async function loadAuth(token: string, reply: FastifyReply): Promise<RequestAuth | null> {
  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
  } catch {
    reply.status(401).send({ error: "Token inválido ou expirado" });
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { tenantId: true, role: true, permissions: true, active: true },
  });
  if (!user || !user.active || user.tenantId !== payload.tenantId) {
    reply.status(401).send({ error: "Usuário desativado ou sem acesso a esta conta" });
    return null;
  }

  return {
    sub: payload.sub,
    tenantId: user.tenantId,
    role: user.role,
    permissions: resolvePermissions(user.role, user.permissions),
  };
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) {
    return reply.status(401).send({ error: "Token ausente" });
  }

  const auth = await loadAuth(token, reply);
  if (auth) request.auth = auth;
}

export function hasPermission(request: FastifyRequest, key: string): boolean {
  return request.auth.permissions.has(key);
}

// preHandler de rota: exige TODAS as permissões listadas. Precisa vir
// depois de authenticate.
export function requirePermission(...keys: string[]) {
  return async function checkPermission(request: FastifyRequest, reply: FastifyReply) {
    const missing = keys.find((k) => !request.auth.permissions.has(k));
    if (missing) {
      return reply.status(403).send({ error: "Você não tem permissão para esta ação" });
    }
  };
}

// Variante "qualquer uma" — pra rotas usadas por mais de uma tela (ex:
// detalhe do contato abre tanto pela conversa quanto pela lista de contatos).
export function requireAnyPermission(...keys: string[]) {
  return async function checkAnyPermission(request: FastifyRequest, reply: FastifyReply) {
    if (!keys.some((k) => request.auth.permissions.has(k))) {
      return reply.status(403).send({ error: "Você não tem permissão para esta ação" });
    }
  };
}

// Variante pra endpoints carregados direto por tag <img>/<audio>/<video> —
// esses elementos não têm como mandar um header Authorization, então
// aceitamos o token também via querystring (?token=...) além do header.
export async function authenticateFromHeaderOrQuery(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const headerToken = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const queryToken = (request.query as Record<string, string> | undefined)?.token;
  const token = headerToken ?? queryToken ?? null;

  if (!token) {
    return reply.status(401).send({ error: "Token ausente" });
  }

  const auth = await loadAuth(token, reply);
  if (auth) request.auth = auth;
}

// Filtros de escopo "só o que é dele" — viram parte do `where` do Prisma.
export function conversationScope(request: FastifyRequest) {
  return request.auth.permissions.has("conversations.only_assigned")
    ? { OR: [{ assignedUserId: request.auth.sub }, { assignedUserId: null }] }
    : {};
}

export function dealScope(request: FastifyRequest) {
  return request.auth.permissions.has("deals.only_assigned")
    ? { OR: [{ assignedUserId: request.auth.sub }, { assignedUserId: null }] }
    : {};
}

export function ownWorkScope(request: FastifyRequest) {
  return request.auth.permissions.has("tasks.view_all")
    ? {}
    : { OR: [{ assignedUserId: request.auth.sub }, { assignedUserId: null }] };
}

// Atribuir tarefa/evento a outra pessoa exige tasks.assign_others; deixar
// sem responsável ou atribuir a si mesmo é sempre permitido.
export function canAssignTo(request: FastifyRequest, assignedUserId: string | null | undefined): boolean {
  if (!assignedUserId || assignedUserId === request.auth.sub) return true;
  return request.auth.permissions.has("tasks.assign_others");
}

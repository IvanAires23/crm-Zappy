import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { disabledPermissionList, resolvePermissions } from "./permissions.js";

export interface AuthPayload {
  sub: string;
  tenantId: string;
  role: string;
}

export type AgencyRole = "agency_admin" | "agency_user";

export interface RequestAuth extends AuthPayload {
  permissions: Set<string>;
  agencyRole: AgencyRole | null;
  homeTenantId: string;
  // true quando um usuário de agência está operando a conta de um cliente.
  acting: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: RequestAuth;
  }
}

export function normalizeAgencyRole(value: string | null | undefined): AgencyRole | null {
  return value === "agency_admin" || value === "agency_user" ? value : null;
}

// Monta a sessão de um usuário dentro de uma conta (tenant). Usado a cada
// request e também no login/refresh/entrar-na-conta, pra que todos
// apliquem exatamente as mesmas regras:
// - conta de origem: papel + exceções do usuário, menos os módulos que a
//   agência desligou na conta (agência não sofre esse corte);
// - outra conta: só usuário de agência (agency_admin em qualquer uma,
//   agency_user nas liberadas pra ele), sempre com os padrões de admin.
export async function resolveSession(
  userId: string,
  tenantId: string
): Promise<{ ok: true; auth: RequestAuth } | { ok: false; error: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, role: true, permissions: true, active: true, agencyRole: true },
  });
  if (!user || !user.active) {
    return { ok: false, error: "Usuário desativado ou sem acesso a esta conta" };
  }
  const agencyRole = normalizeAgencyRole(user.agencyRole);
  const acting = tenantId !== user.tenantId;

  if (acting) {
    const allowed =
      agencyRole === "agency_admin" ||
      (agencyRole === "agency_user" &&
        !!(await prisma.agencyUserAccess.findUnique({ where: { userId_tenantId: { userId, tenantId } } })));
    if (!allowed) return { ok: false, error: "Você não tem acesso a esta conta" };
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true, disabledPermissions: true },
  });
  if (!tenant) return { ok: false, error: "Conta não encontrada" };
  if (!agencyRole && tenant.status !== "active") {
    return { ok: false, error: "Esta conta está suspensa — fale com a agência" };
  }

  const role = acting ? "admin" : user.role;
  const permissions = resolvePermissions(role, acting ? {} : user.permissions);
  if (!agencyRole) {
    for (const key of disabledPermissionList(tenant.disabledPermissions)) permissions.delete(key);
  }

  return {
    ok: true,
    auth: { sub: userId, tenantId, role, permissions, agencyRole, homeTenantId: user.tenantId, acting },
  };
}

// O papel e as permissões vêm do banco a cada request, não do JWT: assim
// desativar um usuário, mudar as permissões dele ou tirar o acesso de
// agência a uma conta vale na hora, sem esperar o access token (1h) expirar.
async function loadAuth(token: string, reply: FastifyReply): Promise<RequestAuth | null> {
  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
  } catch {
    reply.status(401).send({ error: "Token inválido ou expirado" });
    return null;
  }

  const session = await resolveSession(payload.sub, payload.tenantId);
  if (!session.ok) {
    reply.status(401).send({ error: session.error });
    return null;
  }
  return session.auth;
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

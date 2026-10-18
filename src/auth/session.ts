import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { normalizeRole } from "./permissions.js";
import { resolveSession, type RequestAuth } from "./auth.plugin.js";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signAccessToken(auth: RequestAuth): string {
  // Curto de propósito — a longevidade da sessão vem do refresh token (30
  // dias), não do access token. Um token vazado só vale por até 1h.
  return jwt.sign({ sub: auth.sub, tenantId: auth.tenantId, role: auth.role }, env.JWT_SECRET, {
    expiresIn: "1h",
  });
}

async function issueRefreshToken(userId: string, actingTenantId: string | null): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      actingTenantId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return token;
}

// Dados do usuário logado como o frontend precisa — tudo relativo à conta
// em que ele está agora (que pode não ser a de origem, no caso de agência).
export async function sessionUser(auth: RequestAuth) {
  const [user, tenant] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: auth.sub }, select: { id: true, name: true, email: true } }),
    prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { name: true } }),
  ]);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: normalizeRole(auth.role),
    tenantId: auth.tenantId,
    tenantName: tenant.name,
    homeTenantId: auth.homeTenantId,
    agencyRole: auth.agencyRole,
    acting: auth.acting,
    permissions: [...auth.permissions],
  };
}

// Emite access + refresh token pra um usuário dentro de uma conta. O
// refresh guarda a conta, então renovar mantém o usuário onde ele está.
export async function issueSession(userId: string, tenantId: string) {
  const session = await resolveSession(userId, tenantId);
  if (!session.ok) return session;
  const { auth } = session;
  const token = signAccessToken(auth);
  const refreshToken = await issueRefreshToken(userId, auth.acting ? auth.tenantId : null);
  return { ok: true as const, body: { token, refreshToken, user: await sessionUser(auth) } };
}

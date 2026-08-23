import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface AuthPayload {
  sub: string;
  tenantId: string;
  role: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthPayload;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) {
    return reply.status(401).send({ error: "Token ausente" });
  }

  try {
    request.auth = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
  } catch {
    return reply.status(401).send({ error: "Token inválido ou expirado" });
  }
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

  try {
    request.auth = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
  } catch {
    return reply.status(401).send({ error: "Token inválido ou expirado" });
  }
}

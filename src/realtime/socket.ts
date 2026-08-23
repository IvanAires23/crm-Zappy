import type { Server as HTTPServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { allowedOrigins } from "../config/corsOrigins.js";
import { REALTIME_CHANNEL } from "./bus.js";
import type { RealtimeEnvelope } from "./events.js";
import type { AuthPayload } from "../auth/auth.plugin.js";
import { Sentry } from "../config/sentry.js";

// Só a API (não os workers) segura essa instância — os workers publicam
// no Redis via publishRealtimeEvent() e essa função aqui é quem escuta e
// re-emite pros clientes conectados.
export function setupRealtime(httpServer: HTTPServer) {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: allowedOrigins },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next(new Error("Token ausente"));
      return;
    }
    try {
      socket.data.auth = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
      next();
    } catch {
      next(new Error("Token inválido ou expirado"));
    }
  });

  io.on("connection", (socket) => {
    const auth = socket.data.auth as AuthPayload;
    socket.join(`tenant:${auth.tenantId}`);
  });

  // Conexão dedicada só pra subscribe: uma vez em modo subscriber, uma
  // conexão do ioredis não pode mais rodar outros comandos — não dá pra
  // reaproveitar a conexão do BullMQ (queue.ts) aqui.
  const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.subscribe(REALTIME_CHANNEL).catch((err) => {
    Sentry.captureException(err);
  });

  subscriber.on("message", (_channel, raw) => {
    let envelope: RealtimeEnvelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return; // payload malformado — ignora
    }
    io.to(`tenant:${envelope.tenantId}`).emit(envelope.event, envelope.data);
  });

  return io;
}

import { env } from "./env.js";

// Lista de origens liberadas — usada tanto no CORS do Fastify (rotas REST)
// quanto no do Socket.io (src/realtime/socket.ts), que tem sua própria
// configuração separada e precisa do mesmo tratamento.
export const allowedOrigins: string[] = [
  env.FRONTEND_URL,
  ...(env.CORS_ORIGINS ? env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) : []),
];

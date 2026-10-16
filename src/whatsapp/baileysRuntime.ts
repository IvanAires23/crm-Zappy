import { connection } from "../queue/queue.js";

// Estado efêmero da API não oficial, compartilhado entre o worker de
// Baileys (quem escreve) e a API (quem lê, em GET /onboarding/whatsapp/status
// e no start). Fica no Redis, não no Postgres, porque tudo aqui expira
// sozinho — e é o que permite à tela funcionar mesmo se o WebSocket não
// entregar o evento "whatsapp:qr" (reconexão, token expirado, proxy).

const HEARTBEAT_KEY = "baileys:worker:heartbeat";
const HEARTBEAT_TTL_S = 45;
const QR_TTL_S = 60; // o WhatsApp troca o QR a cada ~20s; 60s cobre folga
const ERROR_TTL_S = 600;

const qrKey = (tenantId: string) => `baileys:qr:${tenantId}`;
const errorKey = (tenantId: string) => `baileys:last-error:${tenantId}`;

export async function beatWorkerHeartbeat(): Promise<void> {
  await connection.set(HEARTBEAT_KEY, new Date().toISOString(), "EX", HEARTBEAT_TTL_S);
}

export async function isWorkerOnline(): Promise<boolean> {
  return (await connection.exists(HEARTBEAT_KEY)) === 1;
}

export async function setLatestQr(tenantId: string, qrDataUrl: string): Promise<void> {
  await connection.set(qrKey(tenantId), qrDataUrl, "EX", QR_TTL_S);
}

export async function getLatestQr(tenantId: string): Promise<string | null> {
  return connection.get(qrKey(tenantId));
}

export async function clearLatestQr(tenantId: string): Promise<void> {
  await connection.del(qrKey(tenantId));
}

export async function setLastError(tenantId: string, message: string): Promise<void> {
  await connection.set(errorKey(tenantId), message, "EX", ERROR_TTL_S);
}

export async function getLastError(tenantId: string): Promise<string | null> {
  return connection.get(errorKey(tenantId));
}

export async function clearLastError(tenantId: string): Promise<void> {
  await connection.del(errorKey(tenantId));
}

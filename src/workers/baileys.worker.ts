import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { connection } from "../queue/queue.js";
import { initSentry, Sentry } from "../config/sentry.js";
import { baileysManager } from "../whatsapp/baileysManager.js";
import { BAILEYS_COMMANDS_CHANNEL, type BaileysCommand } from "../whatsapp/baileysCommands.js";
import pino from "pino";

initSentry();

const logger = pino({ transport: { target: "pino-pretty" } });

// Processo dedicado: é o único lugar que segura sockets Baileys vivos em
// memória (um por tenant). API e outros workers só conversam com ele por
// Redis — comando de start/logout via pub/sub (baileysCommands.ts) e envio
// de mensagem via fila BullMQ (unofficialSendQueue em queue.ts), que dá pra
// "esperar" o resultado como uma chamada normal (ver whatsapp/client.ts).
interface SendJobData {
  tenantId: string;
  to: string;
  text: string;
}

const sendWorker = new Worker(
  "whatsapp-unofficial-send",
  async (job: Job<SendJobData>) => {
    const { tenantId, to, text } = job.data;
    return baileysManager.sendText(tenantId, to, text);
  },
  { connection, concurrency: 5 }
);

sendWorker.on("failed", (job, err) => {
  Sentry.captureException(err, { extra: { jobId: job?.id, queue: "whatsapp-unofficial-send" } });
  logger.error({ jobId: job?.id, err }, "Falha ao enviar mensagem via Baileys");
});

// Conexão dedicada só pra subscribe — mesmo motivo do src/realtime/socket.ts:
// uma vez em modo subscriber, a conexão do ioredis não roda mais outros
// comandos, não dá pra reaproveitar a `connection` do BullMQ aqui.
const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
subscriber.subscribe(BAILEYS_COMMANDS_CHANNEL).catch((err) => Sentry.captureException(err));

subscriber.on("message", async (_channel, raw) => {
  let command: BaileysCommand;
  try {
    command = JSON.parse(raw);
  } catch {
    return;
  }

  try {
    if (command.action === "start") await baileysManager.startSession(command.tenantId);
    else if (command.action === "logout") await baileysManager.logoutSession(command.tenantId);
  } catch (err) {
    Sentry.captureException(err, { extra: { command } });
    logger.error({ command, err }, "Falha ao executar comando de Baileys");
  }
});

baileysManager.reconnectAll().catch((err) => {
  Sentry.captureException(err);
  logger.error(err, "Falha ao reconectar sessões Baileys existentes na subida do worker");
});

process.on("uncaughtException", (err) => {
  Sentry.captureException(err);
  logger.error(err, "uncaughtException no worker de baileys");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  Sentry.captureException(err);
  logger.error(err, "unhandledRejection no worker de baileys");
  process.exit(1);
});

logger.info("Worker de Baileys (API não oficial) iniciado");

import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // exigido pelo BullMQ
});

// Fila 1: eventos crus recebidos do webhook da Meta.
// O endpoint HTTP só empurra pra cá e responde 200 na hora.
export const webhookQueue = new Queue("whatsapp-webhook-events", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: false, // falhas ficam guardadas pra inspeção manual
  },
});

// Fila 2: envio de mensagens outbound (dá pra aplicar backoff em rate limit)
export const outboundQueue = new Queue("whatsapp-outbound-messages", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 1000,
    removeOnFail: false,
  },
});

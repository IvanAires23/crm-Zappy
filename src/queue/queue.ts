import { Queue, QueueEvents } from "bullmq";
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

// Fila 3: entrega de webhooks de saída (automação) — n8n ou qualquer
// outra URL configurada por tenant escuta os eventos do CRM aqui.
export const automationQueue = new Queue("crm-automation-dispatch", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 1000,
    removeOnFail: false,
  },
});

// Fila 4: só o "tick" do scheduler (job repetível, sem payload de verdade)
export const schedulerQueue = new Queue("crm-scheduler-tick", { connection });

// Fila 5: envio via API não oficial (Baileys/QR Code). Diferente da fila 2
// (outbound normal), aqui quem chama (whatsapp/client.ts, dentro do próprio
// worker de outbound) precisa do resultado na hora — a sessão Baileys viva
// só existe no processo do worker de baileys (src/workers/baileys.worker.ts),
// então usamos QueueEvents pra "esperar" o job terminar (RPC por cima do
// BullMQ) em vez de inventar outro mecanismo de IPC.
export const unofficialSendQueue = new Queue("whatsapp-unofficial-send", {
  connection,
  defaultJobOptions: {
    attempts: 1, // sem retry automático aqui — quem chama decide o que fazer com o erro
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});

export const unofficialSendQueueEvents = new QueueEvents("whatsapp-unofficial-send", { connection });

import { Worker, type Job } from "bullmq";
import { connection } from "../queue/queue.js";
import { prisma } from "../db/prisma.js";
import { sendTextMessage, WhatsappApiError } from "../whatsapp/client.js";
import pino from "pino";

const logger = pino({ transport: { target: "pino-pretty" } });

interface OutboundJobData {
  tenantId: string;
  messageId: string; // id do registro local em `messages`, criado como "pending" antes de enfileirar
  to: string;
  text: string;
}

const worker = new Worker(
  "whatsapp-outbound-messages",
  async (job: Job<OutboundJobData>) => {
    const { tenantId, messageId, to, text } = job.data;

    try {
      const result = await sendTextMessage(tenantId, to, text);
      const whatsappMessageId = result?.messages?.[0]?.id;

      await prisma.message.update({
        where: { id: messageId },
        data: {
          status: "sent",
          whatsappMessageId, // o status final (delivered/read) chega depois via webhook
        },
      });
    } catch (err) {
      if (err instanceof WhatsappApiError && err.status === 429) {
        // Rate limit — BullMQ já vai reagendar via backoff exponencial configurado na fila.
        logger.warn({ tenantId, messageId }, "Rate limit atingido, reenfileirando com backoff");
        throw err;
      }

      await prisma.message.update({
        where: { id: messageId },
        data: { status: "failed" },
      });

      logger.error({ tenantId, messageId, err }, "Falha ao enviar mensagem");
      throw err; // deixa o BullMQ registrar como failed após esgotar tentativas
    }
  },
  { connection, concurrency: 5 }
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "Job de envio falhou definitivamente");
});

logger.info("Worker de envio (outbound) iniciado");

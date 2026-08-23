import { Worker, type Job } from "bullmq";
import { connection } from "../queue/queue.js";
import { prisma } from "../db/prisma.js";
import { sendTextMessage, sendTemplateMessage } from "../whatsapp/client.js";
import { initSentry, Sentry } from "../config/sentry.js";
import { publishRealtimeEvent } from "../realtime/bus.js";
import pino from "pino";

initSentry();

const logger = pino({ transport: { target: "pino-pretty" } });

interface OutboundJobData {
  tenantId: string;
  messageId: string; // id do registro local em `messages`, criado como "pending" antes de enfileirar
  to: string;
  text?: string; // envio de texto livre (conversa individual)
  template?: { name: string; languageCode: string; components?: unknown[] }; // envio de template (disparo em massa)
  broadcastRecipientId?: string; // presente só em jobs de disparo em massa
}

// Depois de marcar um BroadcastRecipient como sent/failed, atualiza os
// contadores do Broadcast e fecha ele como "completed" quando todo mundo
// já foi processado (sent + failed == total).
async function updateBroadcastProgress(broadcastRecipientId: string, outcome: "sent" | "failed", error?: string) {
  const recipient = await prisma.broadcastRecipient.update({
    where: { id: broadcastRecipientId },
    data: { status: outcome, error },
  });

  const broadcast = await prisma.broadcast.update({
    where: { id: recipient.broadcastId },
    data: outcome === "sent" ? { sentCount: { increment: 1 } } : { failedCount: { increment: 1 } },
  });

  if (broadcast.sentCount + broadcast.failedCount >= broadcast.totalCount) {
    await prisma.broadcast.update({ where: { id: broadcast.id }, data: { status: "completed" } });
  }
}

const worker = new Worker(
  "whatsapp-outbound-messages",
  async (job: Job<OutboundJobData>) => {
    const { tenantId, messageId, to, text, template, broadcastRecipientId } = job.data;

    try {
      const result = template
        ? await sendTemplateMessage(tenantId, to, template.name, template.languageCode, template.components)
        : await sendTextMessage(tenantId, to, text ?? "");
      const whatsappMessageId = result?.messages?.[0]?.id;

      const sentMessage = await prisma.message.update({
        where: { id: messageId },
        data: {
          status: "sent",
          whatsappMessageId, // o status final (delivered/read) chega depois via webhook
        },
      });

      await publishRealtimeEvent({
        tenantId,
        event: "message:status",
        data: { conversationId: sentMessage.conversationId, messageId: sentMessage.id, status: sentMessage.status },
      });

      if (broadcastRecipientId) {
        await updateBroadcastProgress(broadcastRecipientId, "sent");
      }
    } catch (err) {
      // Só marca como "failed" (mensagem + contador do disparo) na última
      // tentativa configurada na fila — antes disso é só um retry em
      // andamento (rate limit ou qualquer outro erro transiente), e marcar
      // cedo faria o Message/BroadcastRecipient ficarem "failed" mesmo que
      // uma tentativa seguinte tivesse sucesso (e contaria duas vezes no
      // disparo em massa).
      const attemptsAllowed = job.opts.attempts ?? 1;
      const isLastAttempt = job.attemptsMade + 1 >= attemptsAllowed;

      if (!isLastAttempt) {
        logger.warn(
          { tenantId, messageId, attempt: job.attemptsMade + 1, attemptsAllowed },
          "Falha ao enviar, tentando de novo"
        );
        throw err;
      }

      const failedMessage = await prisma.message.update({
        where: { id: messageId },
        data: { status: "failed" },
      });

      await publishRealtimeEvent({
        tenantId,
        event: "message:status",
        data: { conversationId: failedMessage.conversationId, messageId: failedMessage.id, status: failedMessage.status },
      });

      if (broadcastRecipientId) {
        await updateBroadcastProgress(broadcastRecipientId, "failed", err instanceof Error ? err.message : String(err));
      }

      logger.error({ tenantId, messageId, err }, "Falha ao enviar mensagem definitivamente");
      throw err; // deixa o BullMQ registrar o job como failed
    }
  },
  { connection, concurrency: 5 }
);

worker.on("failed", (job, err) => {
  Sentry.captureException(err, { extra: { jobId: job?.id, queue: "whatsapp-outbound-messages" } });
  logger.error({ jobId: job?.id, err }, "Job de envio falhou definitivamente");
});

process.on("uncaughtException", (err) => {
  Sentry.captureException(err);
  logger.error(err, "uncaughtException no worker de outbound");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  Sentry.captureException(err);
  logger.error(err, "unhandledRejection no worker de outbound");
  process.exit(1);
});

logger.info("Worker de envio (outbound) iniciado");

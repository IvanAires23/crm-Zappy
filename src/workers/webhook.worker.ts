import { Worker, type Job } from "bullmq";
import { connection } from "../queue/queue.js";
import { prisma } from "../db/prisma.js";
import { initSentry, Sentry } from "../config/sentry.js";
import { publishRealtimeEvent } from "../realtime/bus.js";
import pino from "pino";

initSentry();

const logger = pino({ transport: { target: "pino-pretty" } });

// Payload típico da Meta:
// entry[0].changes[0].value.metadata.phone_number_id
// entry[0].changes[0].value.messages[]  (inbound)
// entry[0].changes[0].value.statuses[]  (status de envio)

const worker = new Worker(
  "whatsapp-webhook-events",
  async (job: Job) => {
    const body = job.data;

    const entries = body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // 1) Resolver a qual tenant esse número pertence
        const account = await prisma.tenantWhatsappAccount.findUnique({
          where: { phoneNumberId },
        });

        if (!account) {
          logger.warn({ phoneNumberId }, "Evento recebido para número não associado a nenhum tenant");
          continue;
        }

        // 2) Mensagens recebidas (inbound)
        for (const msg of value.messages ?? []) {
          await handleInboundMessage(account.tenantId, phoneNumberId, msg, value);
        }

        // 3) Atualizações de status (sent/delivered/read/failed)
        for (const status of value.statuses ?? []) {
          await handleStatusUpdate(account.tenantId, phoneNumberId, status);
        }

        // 4) Coexistência: contatos sincronizados do WhatsApp Business App
        for (const item of value.state_sync ?? []) {
          await handleAppStateSync(account.tenantId, item);
        }

        // 5) Coexistência: mensagens mandadas pelo WhatsApp Business App (celular)
        for (const echo of value.message_echoes ?? []) {
          await handleMessageEcho(account.tenantId, phoneNumberId, echo);
        }

        // 6) Coexistência: histórico antigo sincronizado uma única vez
        if (value.history) {
          await handleHistorySync(account.tenantId, phoneNumberId, value.history);
        }
      }
    }
  },
  { connection, concurrency: 10 }
);

async function findOrCreateOpenConversation(tenantId: string, contactId: string) {
  const existing = await prisma.conversation.findFirst({
    where: { tenantId, contactId, status: { not: "closed" } },
  });
  if (existing) return existing;

  return prisma.conversation.create({
    data: { tenantId, contactId, status: "open" },
  });
}

async function handleInboundMessage(
  tenantId: string,
  phoneNumberId: string,
  msg: any,
  value: any
) {
  const eventKey = `inbound:${msg.id}`;

  // Idempotência: se já processamos esse messageId, sai.
  const existing = await prisma.webhookEvent.findUnique({ where: { whatsappEventKey: eventKey } });
  if (existing?.processedAt) return;

  await prisma.webhookEvent.upsert({
    where: { whatsappEventKey: eventKey },
    create: {
      tenantId,
      whatsappEventKey: eventKey,
      phoneNumberId,
      payload: msg,
    },
    update: { payload: msg },
  });

  const fromPhone: string = msg.from; // já vem em formato internacional
  const contactName: string | undefined = value.contacts?.[0]?.profile?.name;

  const contact = await prisma.contact.upsert({
    where: { tenantId_phone: { tenantId, phone: fromPhone } },
    create: { tenantId, phone: fromPhone, name: contactName },
    update: contactName ? { name: contactName } : {},
  });

  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, contactId: contact.id, status: { not: "closed" } },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, status: "open" },
    });
  }

  const message = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      direction: "inbound",
      type: msg.type,
      content: msg,
      whatsappMessageId: msg.id,
      status: "delivered",
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  await prisma.webhookEvent.update({
    where: { whatsappEventKey: eventKey },
    data: { processedAt: new Date() },
  });

  await publishRealtimeEvent({
    tenantId,
    event: "message:new",
    data: { conversationId: conversation.id, message },
  });

  logger.info({ tenantId, conversationId: conversation.id }, "Mensagem inbound processada");
}

async function handleStatusUpdate(tenantId: string, phoneNumberId: string, status: any) {
  const eventKey = `status:${status.id}:${status.status}`;

  const existing = await prisma.webhookEvent.findUnique({ where: { whatsappEventKey: eventKey } });
  if (existing?.processedAt) return;

  await prisma.webhookEvent.upsert({
    where: { whatsappEventKey: eventKey },
    create: { tenantId, whatsappEventKey: eventKey, phoneNumberId, payload: status },
    update: { payload: status },
  });

  const existingMessage = await prisma.message.findFirst({
    where: { tenantId, whatsappMessageId: status.id },
  });

  if (existingMessage) {
    const updated = await prisma.message.update({
      where: { id: existingMessage.id },
      data: { status: status.status }, // sent | delivered | read | failed
    });

    await publishRealtimeEvent({
      tenantId,
      event: "message:status",
      data: { conversationId: updated.conversationId, messageId: updated.id, status: updated.status },
    });
  }

  await prisma.webhookEvent.update({
    where: { whatsappEventKey: eventKey },
    data: { processedAt: new Date() },
  });

  logger.info({ tenantId, messageId: status.id, status: status.status }, "Status de mensagem atualizado");
}

// Coexistência: a Meta manda a lista de contatos do WhatsApp Business App
// (celular) aqui. `action` pode ser "add" ou "remove" — só tratamos "add",
// já que remover um contato do celular não deve apagar histórico do CRM.
async function handleAppStateSync(tenantId: string, item: any) {
  if (item?.type !== "contact" || item?.action !== "add") return;

  const phone: string | undefined = item.contact?.phone_number;
  if (!phone) return;

  const name: string | undefined = item.contact?.full_name ?? item.contact?.first_name;

  await prisma.contact.upsert({
    where: { tenantId_phone: { tenantId, phone } },
    create: { tenantId, phone, name },
    update: name ? { name } : {},
  });
}

// Coexistência: mensagem que o atendente mandou pelo próprio WhatsApp
// Business App (celular), não pela API — ainda assim precisa aparecer no
// CRM como outbound, senão a conversa fica incompleta.
async function handleMessageEcho(tenantId: string, phoneNumberId: string, echo: any) {
  const eventKey = `echo:${echo.id}`;

  const existing = await prisma.webhookEvent.findUnique({ where: { whatsappEventKey: eventKey } });
  if (existing?.processedAt) return;

  await prisma.webhookEvent.upsert({
    where: { whatsappEventKey: eventKey },
    create: { tenantId, whatsappEventKey: eventKey, phoneNumberId, payload: echo },
    update: { payload: echo },
  });

  const toPhone: string = echo.to;

  const contact = await prisma.contact.upsert({
    where: { tenantId_phone: { tenantId, phone: toPhone } },
    create: { tenantId, phone: toPhone },
    update: {},
  });

  const conversation = await findOrCreateOpenConversation(tenantId, contact.id);

  const message = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      direction: "outbound",
      type: echo.type,
      content: echo,
      whatsappMessageId: echo.id,
      status: "sent",
      source: "business_app",
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  await prisma.webhookEvent.update({
    where: { whatsappEventKey: eventKey },
    data: { processedAt: new Date() },
  });

  await publishRealtimeEvent({
    tenantId,
    event: "message:new",
    data: { conversationId: conversation.id, message },
  });

  logger.info({ tenantId, conversationId: conversation.id }, "Echo de mensagem do app processado");
}

// Coexistência: sincronização de histórico, disparada uma vez no onboarding
// (ver triggerSmbAppDataSync em whatsapp/client.ts). O formato exato de
// `history.threads` não está 100% documentado publicamente — este handler
// guarda o payload cru pra inspeção e faz um melhor-esforço de importação;
// vale conferir contra o payload real recebido em produção antes de confiar
// cegamente nele.
async function handleHistorySync(tenantId: string, phoneNumberId: string, history: any) {
  if (history.errors) {
    await prisma.tenantWhatsappAccount.update({
      where: { phoneNumberId },
      data: { historySyncStatus: "declined" },
    });
    logger.warn({ tenantId, errors: history.errors }, "Sincronização de histórico recusada pelo usuário no app");
    return;
  }

  for (const thread of history.threads ?? []) {
    const phone: string | undefined = thread.id ?? thread.phone_number;
    if (!phone) continue;

    const contact = await prisma.contact.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: { tenantId, phone },
      update: {},
    });

    const conversation = await findOrCreateOpenConversation(tenantId, contact.id);

    for (const msg of thread.messages ?? []) {
      const eventKey = `history:${msg.id}`;
      const existing = await prisma.webhookEvent.findUnique({ where: { whatsappEventKey: eventKey } });
      if (existing?.processedAt) continue;

      await prisma.webhookEvent.upsert({
        where: { whatsappEventKey: eventKey },
        create: { tenantId, whatsappEventKey: eventKey, phoneNumberId, payload: msg },
        update: { payload: msg },
      });

      await prisma.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          direction: msg.from === phone ? "inbound" : "outbound",
          type: msg.type,
          content: msg,
          whatsappMessageId: msg.id,
          status: msg.status ?? "delivered",
          source: "history_sync",
        },
      });

      await prisma.webhookEvent.update({
        where: { whatsappEventKey: eventKey },
        data: { processedAt: new Date() },
      });
    }
  }

  if (history.progress === 100 || history.phase === 2) {
    await prisma.tenantWhatsappAccount.update({
      where: { phoneNumberId },
      data: { historySyncStatus: "completed" },
    });
  }

  logger.info({ tenantId, phoneNumberId }, "Lote de histórico (coexistência) processado");
}

worker.on("failed", (job, err) => {
  Sentry.captureException(err, { extra: { jobId: job?.id, queue: "whatsapp-webhook-events" } });
  logger.error({ jobId: job?.id, err }, "Falha ao processar evento de webhook — vai pra retry/DLQ");
});

process.on("uncaughtException", (err) => {
  Sentry.captureException(err);
  logger.error(err, "uncaughtException no worker de webhook");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  Sentry.captureException(err);
  logger.error(err, "unhandledRejection no worker de webhook");
  process.exit(1);
});

logger.info("Worker de webhook iniciado");

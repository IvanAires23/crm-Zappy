import { Worker, type Job } from "bullmq";
import { connection, outboundQueue } from "../queue/queue.js";
import { prisma } from "../db/prisma.js";
import { initSentry, Sentry } from "../config/sentry.js";
import { publishRealtimeEvent } from "../realtime/bus.js";
import { emitAutomationEvent } from "../automation/emit.js";
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

  const now = new Date();
  await prisma.conversation.update({
    where: { id: conversation.id },
    // lastInboundMessageAt é a base da janela de 24h da Meta — só conta
    // mensagem do cliente, por isso é separado de lastMessageAt (que
    // também muda com mensagem nossa, no echo abaixo por exemplo).
    data: { lastMessageAt: now, lastInboundMessageAt: now },
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

  await emitAutomationEvent(tenantId, "message.received", {
    contactId: contact.id,
    contactPhone: contact.phone,
    contactName: contact.name,
    conversationId: conversation.id,
    channel: "whatsapp",
    text: msg.type === "text" ? msg.text?.body ?? "" : "",
    messageType: msg.type,
  });

  await maybeTriggerChatbotReply(tenantId, conversation.id, fromPhone, msg);
}

// Chatbot simples de palavra-chave: sem IA, sem árvore de decisão — só
// deflection de FAQ. Só reage a mensagem de texto (mídia não tem o que
// comparar) e usa a primeira regra ativa cujo keyword aparece no texto
// (case-insensitive, substring). Sempre responde, mesmo se um atendente
// já estiver na conversa — não há "pausa automática" ainda.
async function maybeTriggerChatbotReply(
  tenantId: string,
  conversationId: string,
  toPhone: string,
  msg: any
) {
  if (msg.type !== "text") return;
  const text: string | undefined = msg.text?.body;
  if (!text) return;

  const rules = await prisma.chatbotRule.findMany({ where: { tenantId, isActive: true } });
  const matched = rules.find((rule) => text.toLowerCase().includes(rule.keyword.toLowerCase()));
  if (!matched) return;

  const reply = await prisma.message.create({
    data: {
      tenantId,
      conversationId,
      direction: "outbound",
      type: "text",
      content: { text: matched.replyText },
      status: "pending",
      source: "bot",
    },
  });

  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });

  await outboundQueue.add("send-message", {
    tenantId,
    messageId: reply.id,
    to: toPhone,
    text: matched.replyText,
  });

  await publishRealtimeEvent({
    tenantId,
    event: "message:new",
    data: { conversationId, message: reply },
  });

  logger.info({ tenantId, conversationId, ruleId: matched.id }, "Resposta automática do chatbot enfileirada");
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

// Coexistência: sincronização de histórico (até ~6 meses), pedida no
// onboarding ou pelo botão "Sincronizar histórico" (rota sync-history).
// A Meta manda `value.history` como LISTA de lotes:
//   [{ metadata: { phase, chunk_order, progress }, threads: [{ id, messages }] }]
// ou [{ errors: [...] }] quando o usuário recusa no celular. O handler antigo
// lia como objeto único, então nada era importado. Aceita os dois formatos.
async function handleHistorySync(tenantId: string, phoneNumberId: string, history: any) {
  const chunks: any[] = Array.isArray(history) ? history : [history];

  for (const chunk of chunks) {
    const meta = chunk?.metadata ?? {};

    // Guarda o lote cru pra inspeção — o formato não é 100% documentado e
    // um lote perdido não é reenviado pela Meta.
    const rawKey = `history-raw:${phoneNumberId}:${meta.phase ?? "x"}:${meta.chunk_order ?? Date.now()}`;
    await prisma.webhookEvent.upsert({
      where: { whatsappEventKey: rawKey },
      create: { tenantId, whatsappEventKey: rawKey, phoneNumberId, payload: chunk },
      update: { payload: chunk },
    });

    if (chunk?.errors) {
      await prisma.tenantWhatsappAccount.update({
        where: { phoneNumberId },
        data: { historySyncStatus: "declined" },
      });
      logger.warn({ tenantId, errors: chunk.errors }, "Sincronização de histórico recusada/falhou");
      continue;
    }

    let imported = 0;
    for (const thread of chunk?.threads ?? []) {
      const phone: string | undefined = thread.id ?? thread.phone_number;
      if (!phone) continue;

      const contact = await prisma.contact.upsert({
        where: { tenantId_phone: { tenantId, phone } },
        create: { tenantId, phone },
        update: {},
      });

      const conversation = await findOrCreateOpenConversation(tenantId, contact.id);
      let latest: Date | null = null;

      for (const msg of thread.messages ?? []) {
        if (!msg?.id) continue;
        // whatsappMessageId é único: mensagens recentes (já recebidas por
        // webhook ou echo) também vêm no histórico. Sem pular, o create
        // estourava P2002 e o lote inteiro falhava em todas as tentativas.
        const already = await prisma.message.findUnique({ where: { whatsappMessageId: msg.id } });
        if (already) continue;

        const sentAt = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();

        await prisma.message.create({
          data: {
            tenantId,
            conversationId: conversation.id,
            direction: msg.from === phone ? "inbound" : "outbound",
            type: msg.type ?? "unknown",
            content: msg,
            whatsappMessageId: msg.id,
            status: msg.history_context?.status?.toLowerCase?.() ?? msg.status ?? "delivered",
            source: "history_sync",
            // Data real da mensagem, não a da importação — senão o histórico
            // inteiro aparece como "agora" e fora de ordem.
            createdAt: sentAt,
          },
        });
        imported++;
        if (!latest || sentAt > latest) latest = sentAt;
      }

      if (latest && (!conversation.lastMessageAt || latest > conversation.lastMessageAt)) {
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: latest } });
      }
    }

    const done = meta.progress === 100 || chunk?.progress === 100;
    await prisma.tenantWhatsappAccount.update({
      where: { phoneNumberId },
      data: { historySyncStatus: done ? "completed" : "in_progress" },
    });

    logger.info(
      { tenantId, phoneNumberId, phase: meta.phase, chunk: meta.chunk_order, progress: meta.progress, imported },
      "Lote de histórico (coexistência) processado"
    );
  }
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

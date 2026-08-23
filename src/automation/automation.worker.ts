import { Worker, type Job } from "bullmq";
import crypto from "node:crypto";
import pino from "pino";
import { connection, schedulerQueue, outboundQueue } from "../queue/queue.js";
import { prisma } from "../db/prisma.js";
import { emitAutomationEvent } from "./emit.js";
import { executeAction, type RuleAction } from "./actions.js";
import { pullAllConnectedGoogleCalendars } from "../integrations/googleCalendar/googleCalendarSync.js";
import { isMessagingRestricted } from "../whatsapp/window.js";
import { getTenantProvider } from "../whatsapp/client.js";
import { publishRealtimeEvent } from "../realtime/bus.js";
import { initSentry, Sentry } from "../config/sentry.js";

initSentry();

const logger = pino({ transport: { target: "pino-pretty" } });

// --- Entrega dos webhooks de automação ---

interface DispatchJobData {
  webhookId: string;
  event: string;
  data: unknown;
}

async function handleWebhookDispatch(job: Job<DispatchJobData>) {
  const { webhookId, event, data } = job.data;

  const webhook = await prisma.automationWebhook.findUnique({ where: { id: webhookId } });
  if (!webhook || !webhook.isActive) return;

  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  const signature = "sha256=" + crypto.createHmac("sha256", webhook.secret).update(payload).digest("hex");

  const res = await fetch(webhook.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CRM-Signature-256": signature },
    body: payload,
  });

  await prisma.automationDelivery.updateMany({
    where: { jobId: job.id! },
    data: {
      status: res.ok ? "delivered" : "failed",
      responseStatus: res.status,
      attemptCount: job.attemptsMade + 1,
    },
  });

  if (!res.ok) {
    throw new Error(`Webhook de automação respondeu ${res.status}`);
  }
}

// --- Execução de regras internas ---

interface ExecuteRuleJobData {
  ruleId: string;
  tenantId: string;
  event: string;
  data: Record<string, unknown>;
}

async function handleRuleExecution(job: Job<ExecuteRuleJobData>) {
  const { ruleId, tenantId, data } = job.data;

  const rule = await prisma.automationRule.findUnique({ where: { id: ruleId } });
  if (!rule || !rule.isActive) return;

  const actions = rule.actions as unknown as RuleAction[];
  for (const action of actions) {
    await executeAction(tenantId, action, data);
  }

  await prisma.automationRuleRun.updateMany({
    where: { jobId: job.id! },
    data: { status: "success" },
  });
}

const dispatchWorker = new Worker(
  "crm-automation-dispatch",
  async (job: Job) => {
    if (job.name === "execute-rule") {
      await handleRuleExecution(job as Job<ExecuteRuleJobData>);
    } else {
      await handleWebhookDispatch(job as Job<DispatchJobData>);
    }
  },
  { connection, concurrency: 5 }
);

dispatchWorker.on("failed", async (job, err) => {
  if (!job) return;

  Sentry.captureException(err, { extra: { jobId: job.id, jobName: job.name } });

  if (job.name === "execute-rule") {
    await prisma.automationRuleRun.updateMany({
      where: { jobId: job.id! },
      data: { status: "failed", error: err.message },
    });
    logger.error({ jobId: job.id, err }, "Falha ao executar regra de automação — esgotou as tentativas");
  } else {
    await prisma.automationDelivery.updateMany({
      where: { jobId: job.id! },
      data: { status: "failed", error: err.message, attemptCount: job.attemptsMade },
    });
    logger.error({ jobId: job.id, err }, "Falha ao entregar webhook de automação — esgotou as tentativas");
  }
});

logger.info("Worker de automação (dispatch de webhooks + execução de regras) iniciado");

// --- Scheduler: varre gatilhos baseados em tempo a cada 5 minutos ---

const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;

async function checkOverdueTasks() {
  const now = new Date();
  const overdue = await prisma.task.findMany({
    where: { status: "pending", dueAt: { lt: now }, overdueNotifiedAt: null },
  });

  for (const task of overdue) {
    await emitAutomationEvent(task.tenantId, "task.overdue", {
      taskId: task.id,
      title: task.title,
      dueAt: task.dueAt,
      contactId: task.contactId,
      dealId: task.dealId,
    });
    await prisma.task.update({ where: { id: task.id }, data: { overdueNotifiedAt: now } });
  }

  if (overdue.length > 0) {
    logger.info({ count: overdue.length }, "Tasks atrasadas notificadas");
  }
}

async function checkCalendarReminders() {
  const now = new Date();
  const candidates = await prisma.calendarEvent.findMany({
    where: {
      status: "scheduled",
      reminderSentAt: null,
      reminderMinutesBefore: { not: null },
      startAt: { gt: now },
    },
    include: { contact: { select: { id: true, name: true, phone: true } } },
  });

  const due = candidates.filter(
    (event) => new Date(event.startAt.getTime() - (event.reminderMinutesBefore ?? 0) * 60000) <= now
  );

  for (const event of due) {
    await emitAutomationEvent(event.tenantId, "calendar.reminder_due", {
      eventId: event.id,
      title: event.title,
      startAt: event.startAt,
      contact: event.contact,
    });
    await prisma.calendarEvent.update({ where: { id: event.id }, data: { reminderSentAt: now } });
  }

  if (due.length > 0) {
    logger.info({ count: due.length }, "Lembretes de calendário notificados");
  }
}

// Mensagens agendadas pelo atendente (ver POST /conversations/:id/scheduled-messages)
// — a janela de 24h é checada de novo aqui, não só na criação, porque
// pode ter fechado entre o agendamento e o horário marcado. Se fechou,
// marca "failed" em vez de tentar enviar (evita um erro genérico da Meta
// sem contexto nenhum pro atendente entender depois).
async function checkScheduledMessages() {
  const now = new Date();
  const due = await prisma.scheduledMessage.findMany({
    where: { status: "pending", scheduledFor: { lte: now } },
    include: { conversation: { include: { contact: true } } },
  });

  for (const scheduled of due) {
    const provider = await getTenantProvider(scheduled.tenantId);
    if (isMessagingRestricted(provider, scheduled.conversation.lastInboundMessageAt)) {
      await prisma.scheduledMessage.update({
        where: { id: scheduled.id },
        data: { status: "failed", error: "Janela de 24h fechou antes do horário agendado" },
      });
      continue;
    }

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          tenantId: scheduled.tenantId,
          conversationId: scheduled.conversationId,
          direction: "outbound",
          type: "text",
          content: { text: scheduled.text },
          status: "pending",
        },
      });
      await tx.conversation.update({ where: { id: scheduled.conversationId }, data: { lastMessageAt: now } });
      await tx.scheduledMessage.update({ where: { id: scheduled.id }, data: { status: "sent" } });
      return created;
    });

    await outboundQueue.add("send-message", {
      tenantId: scheduled.tenantId,
      messageId: message.id,
      to: scheduled.conversation.contact.phone,
      text: scheduled.text,
    });

    await publishRealtimeEvent({
      tenantId: scheduled.tenantId,
      event: "message:new",
      data: { conversationId: scheduled.conversationId, message },
    });
  }

  if (due.length > 0) {
    logger.info({ count: due.length }, "Mensagens agendadas processadas");
  }
}

const schedulerWorker = new Worker(
  "crm-scheduler-tick",
  async () => {
    await checkOverdueTasks();
    await checkCalendarReminders();
    await checkScheduledMessages();
    await pullAllConnectedGoogleCalendars();
  },
  { connection, concurrency: 1 }
);

schedulerWorker.on("failed", (job, err) => {
  Sentry.captureException(err, { extra: { jobId: job?.id, queue: "crm-scheduler-tick" } });
  logger.error({ jobId: job?.id, err }, "Tick do scheduler falhou");
});

// Job repetível nativo do BullMQ — não precisa de lib de cron externa.
// jobId fixo evita duplicar o agendamento se o worker reiniciar.
await schedulerQueue.add("tick", {}, { repeat: { every: SCHEDULER_INTERVAL_MS }, jobId: "scheduler-tick" });

logger.info({ intervalMs: SCHEDULER_INTERVAL_MS }, "Scheduler iniciado");

process.on("uncaughtException", (err) => {
  Sentry.captureException(err);
  logger.error(err, "uncaughtException no worker de automação");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  Sentry.captureException(err);
  logger.error(err, "unhandledRejection no worker de automação");
  process.exit(1);
});

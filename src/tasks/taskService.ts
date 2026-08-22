import { prisma } from "../db/prisma.js";
import { deleteGoogleEventForCalendarEvent, syncCalendarEventToGoogle } from "../integrations/googleCalendar/googleCalendarSync.js";

// Toda Task tem um CalendarEvent espelho (pra aparecer no calendário e,
// dali, sincronizar com o Google) — esse módulo é o único lugar que deve
// escrever em Task, exatamente pra manter os dois em sincronia. Rotas e
// automações chamam essas funções em vez de usar prisma.task diretamente.

const DEFAULT_DURATION_MS = 30 * 60 * 1000;

export interface TaskWriteInput {
  title?: string;
  description?: string | null;
  type?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  conversationId?: string | null;
  assignedUserId?: string | null;
  dueAt?: Date;
  priority?: "low" | "medium" | "high";
}

interface TaskCalendarFields {
  title: string;
  description: string | null;
  dueAt: Date;
  contactId: string | null;
  dealId: string | null;
  assignedUserId: string | null;
}

function calendarEventFieldsFromTask(task: TaskCalendarFields) {
  return {
    title: task.title,
    description: task.description,
    startAt: task.dueAt,
    endAt: new Date(task.dueAt.getTime() + DEFAULT_DURATION_MS),
    contactId: task.contactId,
    dealId: task.dealId,
    assignedUserId: task.assignedUserId,
  };
}

export async function createTask(tenantId: string, input: TaskWriteInput & { title: string; dueAt: Date }) {
  const task = await prisma.task.create({ data: { tenantId, ...input } });

  const calendarEvent = await prisma.calendarEvent.create({
    data: { tenantId, taskId: task.id, status: "scheduled", ...calendarEventFieldsFromTask(task) },
  });

  void syncCalendarEventToGoogle(calendarEvent.id);

  return task;
}

export async function updateTask(id: string, input: TaskWriteInput) {
  const task = await prisma.task.update({ where: { id }, data: input, include: { calendarEvent: true } });

  const calendarEvent = task.calendarEvent
    ? await prisma.calendarEvent.update({
        where: { id: task.calendarEvent.id },
        data: calendarEventFieldsFromTask(task),
      })
    : await prisma.calendarEvent.create({
        data: { tenantId: task.tenantId, taskId: task.id, status: "scheduled", ...calendarEventFieldsFromTask(task) },
      });

  void syncCalendarEventToGoogle(calendarEvent.id);

  // task.calendarEvent veio do estado *antes* do update acima — troca pela
  // versão fresca pra quem recebe o retorno não ver um status desatualizado.
  return { ...task, calendarEvent };
}

export async function setTaskStatus(id: string, status: "pending" | "completed" | "canceled") {
  const task = await prisma.task.update({
    where: { id },
    data: { status, completedAt: status === "completed" ? new Date() : null },
    include: { calendarEvent: true },
  });

  if (!task.calendarEvent) return task;

  const calendarStatus = status === "pending" ? "scheduled" : status;
  const calendarEvent = await prisma.calendarEvent.update({
    where: { id: task.calendarEvent.id },
    data: { status: calendarStatus },
  });
  void syncCalendarEventToGoogle(calendarEvent.id);

  return { ...task, calendarEvent };
}

export async function deleteTask(id: string) {
  const task = await prisma.task.findUnique({ where: { id }, include: { calendarEvent: true } });
  if (!task) return null;

  if (task.calendarEvent) {
    await deleteGoogleEventForCalendarEvent(task.calendarEvent);
  }

  // onDelete: Cascade no CalendarEvent.task cuida de apagar o evento espelho junto.
  await prisma.task.delete({ where: { id } });
  return task;
}

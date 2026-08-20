import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const createEventSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    allDay: z.boolean().optional(),
    location: z.string().optional(),
    meetingUrl: z.string().url().optional(),
    contactId: z.string().min(1).optional(),
    dealId: z.string().min(1).optional(),
    assignedUserId: z.string().min(1).optional(),
    reminderMinutesBefore: z.number().int().min(0).optional(),
  })
  .refine((data) => data.endAt >= data.startAt, {
    message: "endAt precisa ser igual ou depois de startAt",
    path: ["endAt"],
  });

const updateEventSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional(),
    allDay: z.boolean().optional(),
    location: z.string().nullable().optional(),
    meetingUrl: z.string().url().nullable().optional(),
    contactId: z.string().min(1).nullable().optional(),
    dealId: z.string().min(1).nullable().optional(),
    assignedUserId: z.string().min(1).nullable().optional(),
    reminderMinutesBefore: z.number().int().min(0).nullable().optional(),
  })
  .refine((data) => !data.startAt || !data.endAt || data.endAt >= data.startAt, {
    message: "endAt precisa ser igual ou depois de startAt",
    path: ["endAt"],
  });

const updateStatusSchema = z.object({
  status: z.enum(["scheduled", "completed", "canceled"]),
});

const listQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  contactId: z.string().min(1).optional(),
  dealId: z.string().min(1).optional(),
  assignedUserId: z.string().min(1).optional(),
  status: z.enum(["scheduled", "completed", "canceled"]).optional(),
});

export async function calendarRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.post("/calendar/events", async (request, reply) => {
    const parsed = createEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { contactId, dealId } = parsed.data;

    if (contactId) {
      const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
      if (!contact) return reply.status(400).send({ error: "Contato não encontrado" });
    }
    if (dealId) {
      const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId } });
      if (!deal) return reply.status(400).send({ error: "Deal não encontrado" });
    }

    const event = await prisma.calendarEvent.create({
      data: { tenantId, ...parsed.data },
    });

    return reply.status(201).send(event);
  });

  // Lista eventos que se sobrepõem ao intervalo [from, to] — é o que uma
  // visão de calendário (mês/semana) precisa: pega até eventos que
  // começaram antes do intervalo visível mas ainda não terminaram.
  app.get("/calendar/events", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { from, to, contactId, dealId, assignedUserId, status } = parsed.data;

    const where = {
      tenantId,
      ...(from ? { endAt: { gte: from } } : {}),
      ...(to ? { startAt: { lte: to } } : {}),
      ...(contactId ? { contactId } : {}),
      ...(dealId ? { dealId } : {}),
      ...(assignedUserId ? { assignedUserId } : {}),
      ...(status ? { status } : {}),
    };

    const events = await prisma.calendarEvent.findMany({
      where,
      orderBy: { startAt: "asc" },
      include: {
        contact: { select: { id: true, name: true, phone: true } },
        deal: { select: { id: true, title: true } },
        assignedUser: { select: { id: true, name: true } },
      },
    });

    return reply.send(events);
  });

  app.get("/calendar/events/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const event = await prisma.calendarEvent.findFirst({
      where: { id, tenantId },
      include: {
        contact: { select: { id: true, name: true, phone: true } },
        deal: { select: { id: true, title: true } },
        assignedUser: { select: { id: true, name: true, email: true } },
      },
    });

    if (!event) return reply.status(404).send({ error: "Evento não encontrado" });
    return reply.send(event);
  });

  app.patch("/calendar/events/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.calendarEvent.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Evento não encontrado" });

    const nextStartAt = parsed.data.startAt ?? existing.startAt;
    const nextEndAt = parsed.data.endAt ?? existing.endAt;
    if (nextEndAt < nextStartAt) {
      return reply.status(400).send({ error: "endAt precisa ser igual ou depois de startAt" });
    }

    if (parsed.data.contactId) {
      const contact = await prisma.contact.findFirst({ where: { id: parsed.data.contactId, tenantId } });
      if (!contact) return reply.status(400).send({ error: "Contato não encontrado" });
    }
    if (parsed.data.dealId) {
      const deal = await prisma.deal.findFirst({ where: { id: parsed.data.dealId, tenantId } });
      if (!deal) return reply.status(400).send({ error: "Deal não encontrado" });
    }

    const event = await prisma.calendarEvent.update({ where: { id }, data: parsed.data });
    return reply.send(event);
  });

  app.patch("/calendar/events/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.calendarEvent.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Evento não encontrado" });

    const event = await prisma.calendarEvent.update({
      where: { id },
      data: { status: parsed.data.status },
    });

    return reply.send(event);
  });

  app.delete("/calendar/events/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.calendarEvent.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Evento não encontrado" });

    await prisma.calendarEvent.delete({ where: { id } });
    return reply.status(204).send();
  });
}

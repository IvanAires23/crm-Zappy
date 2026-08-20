import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional(),
  contactId: z.string().min(1).optional(),
  dealId: z.string().min(1).optional(),
  assignedUserId: z.string().min(1).optional(),
  dueAt: z.coerce.date(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  contactId: z.string().min(1).nullable().optional(),
  dealId: z.string().min(1).nullable().optional(),
  assignedUserId: z.string().min(1).nullable().optional(),
  dueAt: z.coerce.date().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["pending", "completed", "canceled"]),
});

const listQuerySchema = z.object({
  contactId: z.string().min(1).optional(),
  dealId: z.string().min(1).optional(),
  assignedUserId: z.string().min(1).optional(),
  status: z.enum(["pending", "completed", "canceled"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  overdue: z.coerce.boolean().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function tasksRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.post("/tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
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

    const task = await prisma.task.create({
      data: { tenantId, ...parsed.data },
    });

    return reply.status(201).send(task);
  });

  app.get("/tasks", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { contactId, dealId, assignedUserId, status, priority, overdue, search, page, pageSize } = parsed.data;

    const where = {
      tenantId,
      ...(contactId ? { contactId } : {}),
      ...(dealId ? { dealId } : {}),
      ...(assignedUserId ? { assignedUserId } : {}),
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(overdue ? { status: "pending", dueAt: { lt: new Date() } } : {}),
      ...(search ? { title: { contains: search, mode: "insensitive" as const } } : {}),
    };

    const [tasks, total] = await Promise.all([
      prisma.task.findMany({
        where,
        orderBy: { dueAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          contact: { select: { id: true, name: true, phone: true } },
          deal: { select: { id: true, title: true } },
          assignedUser: { select: { id: true, name: true } },
        },
      }),
      prisma.task.count({ where }),
    ]);

    return reply.send({ tasks, total, page, pageSize });
  });

  app.get("/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const task = await prisma.task.findFirst({
      where: { id, tenantId },
      include: {
        contact: { select: { id: true, name: true, phone: true } },
        deal: { select: { id: true, title: true } },
        assignedUser: { select: { id: true, name: true, email: true } },
      },
    });

    if (!task) return reply.status(404).send({ error: "Task não encontrada" });
    return reply.send(task);
  });

  app.patch("/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.task.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Task não encontrada" });

    if (parsed.data.contactId) {
      const contact = await prisma.contact.findFirst({ where: { id: parsed.data.contactId, tenantId } });
      if (!contact) return reply.status(400).send({ error: "Contato não encontrado" });
    }
    if (parsed.data.dealId) {
      const deal = await prisma.deal.findFirst({ where: { id: parsed.data.dealId, tenantId } });
      if (!deal) return reply.status(400).send({ error: "Deal não encontrado" });
    }

    const task = await prisma.task.update({ where: { id }, data: parsed.data });
    return reply.send(task);
  });

  // Marca como concluída/cancelada, ou reabre (status: "pending").
  app.patch("/tasks/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.task.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Task não encontrada" });

    const { status } = parsed.data;

    const task = await prisma.task.update({
      where: { id },
      data: { status, completedAt: status === "completed" ? new Date() : null },
    });

    return reply.send(task);
  });

  app.delete("/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.task.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Task não encontrada" });

    await prisma.task.delete({ where: { id } });
    return reply.status(204).send();
  });
}

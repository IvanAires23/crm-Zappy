import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("update_deal_status"),
    status: z.enum(["open", "won", "lost"]),
    lostReason: z.string().optional(),
  }),
  z.object({
    type: z.literal("move_deal_stage"),
    stageId: z.string().min(1),
  }),
  z.object({
    type: z.literal("create_task"),
    title: z.string().min(1),
    description: z.string().optional(),
    dueInMinutes: z.number().int().min(0).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    assignedUserId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("create_deal"),
    stageId: z.string().min(1),
    title: z.string().min(1).optional(),
  }),
]);

const createRuleSchema = z.object({
  name: z.string().min(1),
  triggerEvent: z.string().min(1),
  triggerConditions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  actions: z.array(actionSchema).min(1),
  isActive: z.boolean().optional(),
});

const updateRuleSchema = z.object({
  name: z.string().min(1).optional(),
  triggerEvent: z.string().min(1).optional(),
  triggerConditions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable().optional(),
  actions: z.array(actionSchema).min(1).optional(),
  isActive: z.boolean().optional(),
});

// Catálogo estático dos eventos que o CRM emite hoje, pra frontend montar
// um seletor de gatilho sem precisar adivinhar nome/campos disponíveis.
const EVENT_CATALOG = [
  {
    event: "deal.created",
    description: "Quando um novo deal é criado",
    fields: ["dealId", "title", "pipelineId", "stageId", "contactId"],
  },
  {
    event: "deal.stage_changed",
    description: "Quando um deal muda de estágio",
    fields: ["dealId", "title", "pipelineId", "fromStageId", "toStageId", "toStageName", "contact"],
  },
  {
    event: "deal.status_changed",
    description: "Quando um deal é marcado como ganho ou perdido",
    fields: ["dealId", "title", "status", "lostReason"],
  },
  {
    event: "deal.tag_added",
    description: "Quando uma tag é adicionada a um deal",
    fields: ["dealId", "tagId", "tagName"],
  },
  {
    event: "contact.tag_added",
    description: "Quando uma tag é adicionada a um contato",
    fields: ["contactId", "contactPhone", "contactName", "tagId", "tagName"],
  },
  {
    event: "task.completed",
    description: "Quando uma task é concluída",
    fields: ["taskId", "title", "contactId", "dealId"],
  },
  {
    event: "task.overdue",
    description: "Quando uma task vence (verificado a cada 5 min)",
    fields: ["taskId", "title", "dueAt", "contactId", "dealId"],
  },
  {
    event: "calendar.reminder_due",
    description: "Quando chega a hora do lembrete de um evento de calendário",
    fields: ["eventId", "title", "startAt", "contact"],
  },
];

export async function automationRulesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/automation/events", async (_request, reply) => {
    return reply.send(EVENT_CATALOG);
  });

  app.post("/automation/rules", async (request, reply) => {
    const parsed = createRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;

    const rule = await prisma.automationRule.create({
      data: {
        tenantId,
        name: parsed.data.name,
        triggerEvent: parsed.data.triggerEvent,
        triggerConditions: parsed.data.triggerConditions ?? undefined,
        actions: parsed.data.actions,
        isActive: parsed.data.isActive ?? true,
      },
    });

    return reply.status(201).send(rule);
  });

  app.get("/automation/rules", async (request, reply) => {
    const tenantId = request.auth.tenantId;

    const rules = await prisma.automationRule.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });

    return reply.send(rules);
  });

  app.get("/automation/rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const rule = await prisma.automationRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: "Regra não encontrada" });

    return reply.send(rule);
  });

  app.patch("/automation/rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.automationRule.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Regra não encontrada" });

    const rule = await prisma.automationRule.update({
      where: { id },
      data: {
        ...parsed.data,
        triggerConditions:
          parsed.data.triggerConditions === undefined
            ? undefined
            : parsed.data.triggerConditions === null
              ? Prisma.JsonNull
              : parsed.data.triggerConditions,
      },
    });

    return reply.send(rule);
  });

  app.delete("/automation/rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.automationRule.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Regra não encontrada" });

    await prisma.$transaction([
      prisma.automationRuleRun.deleteMany({ where: { ruleId: id } }),
      prisma.automationRule.delete({ where: { id } }),
    ]);

    return reply.status(204).send();
  });

  // Histórico de execuções — pra debugar sem adivinhar se a regra rodou
  // e o que ela fez.
  app.get("/automation/rules/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const rule = await prisma.automationRule.findFirst({ where: { id, tenantId } });
    if (!rule) return reply.status(404).send({ error: "Regra não encontrada" });

    const runs = await prisma.automationRuleRun.findMany({
      where: { ruleId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return reply.send(runs);
  });
}

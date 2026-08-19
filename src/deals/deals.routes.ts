import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";
import { resolveTagId } from "../tags/findOrCreateTag.js";

const attachTagSchema = z.object({
  tagId: z.string().min(1).optional(),
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const createDealSchema = z.object({
  pipelineId: z.string().min(1),
  stageId: z.string().min(1).optional(), // se omitido, usa o primeiro estágio do pipeline
  contactId: z.string().min(1).optional(),
  title: z.string().min(1),
  valueCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  expectedCloseAt: z.coerce.date().optional(),
  assignedUserId: z.string().min(1).optional(),
});

const updateDealSchema = z.object({
  title: z.string().min(1).optional(),
  valueCents: z.number().int().min(0).nullable().optional(),
  currency: z.string().length(3).optional(),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  assignedUserId: z.string().min(1).nullable().optional(),
  contactId: z.string().min(1).nullable().optional(),
});

const moveStageSchema = z.object({
  stageId: z.string().min(1),
  position: z.number().int().min(0).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["open", "won", "lost"]),
  lostReason: z.string().optional(),
});

const listQuerySchema = z.object({
  pipelineId: z.string().min(1).optional(),
  stageId: z.string().min(1).optional(),
  assignedUserId: z.string().min(1).optional(),
  contactId: z.string().min(1).optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function dealsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.post("/deals", async (request, reply) => {
    const parsed = createDealSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { pipelineId, contactId, title, valueCents, currency, expectedCloseAt, assignedUserId } = parsed.data;

    const pipeline = await prisma.pipeline.findFirst({
      where: { id: pipelineId, tenantId },
      include: { stages: { orderBy: { order: "asc" }, take: 1 } },
    });
    if (!pipeline) return reply.status(400).send({ error: "Pipeline não encontrado" });

    let stageId = parsed.data.stageId;
    if (stageId) {
      const stage = await prisma.pipelineStage.findFirst({ where: { id: stageId, pipelineId } });
      if (!stage) return reply.status(400).send({ error: "Estágio não pertence a esse pipeline" });
    } else {
      if (!pipeline.stages[0]) return reply.status(400).send({ error: "Pipeline não tem nenhum estágio" });
      stageId = pipeline.stages[0].id;
    }

    if (contactId) {
      const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
      if (!contact) return reply.status(400).send({ error: "Contato não encontrado" });
    }

    const lastInStage = await prisma.deal.findFirst({
      where: { stageId },
      orderBy: { position: "desc" },
    });

    const deal = await prisma.$transaction(async (tx) => {
      const created = await tx.deal.create({
        data: {
          tenantId,
          pipelineId,
          stageId,
          contactId,
          title,
          valueCents,
          currency,
          expectedCloseAt,
          assignedUserId,
          position: (lastInStage?.position ?? -1) + 1,
        },
      });

      await tx.dealStageHistory.create({
        data: {
          dealId: created.id,
          fromStageId: null,
          toStageId: stageId,
          movedByUserId: request.auth.sub,
        },
      });

      return created;
    });

    return reply.status(201).send(deal);
  });

  app.get("/deals", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { pipelineId, stageId, assignedUserId, contactId, status, search, page, pageSize } = parsed.data;

    const where = {
      tenantId,
      ...(pipelineId ? { pipelineId } : {}),
      ...(stageId ? { stageId } : {}),
      ...(assignedUserId ? { assignedUserId } : {}),
      ...(contactId ? { contactId } : {}),
      ...(status ? { status } : {}),
      ...(search ? { title: { contains: search, mode: "insensitive" as const } } : {}),
    };

    const [deals, total] = await Promise.all([
      prisma.deal.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          stage: { select: { id: true, name: true } },
          contact: { select: { id: true, name: true, phone: true } },
          assignedUser: { select: { id: true, name: true } },
          tags: { include: { tag: true } },
        },
      }),
      prisma.deal.count({ where }),
    ]);

    return reply.send({ deals, total, page, pageSize });
  });

  app.get("/deals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const deal = await prisma.deal.findFirst({
      where: { id, tenantId },
      include: {
        pipeline: { select: { id: true, name: true } },
        stage: { select: { id: true, name: true } },
        contact: true,
        assignedUser: { select: { id: true, name: true, email: true } },
        tags: { include: { tag: true } },
        stageHistory: {
          orderBy: { movedAt: "desc" },
          take: 20,
          include: {
            fromStage: { select: { id: true, name: true } },
            toStage: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!deal) return reply.status(404).send({ error: "Deal não encontrado" });
    return reply.send(deal);
  });

  app.patch("/deals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateDealSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.deal.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Deal não encontrado" });

    if (parsed.data.contactId) {
      const contact = await prisma.contact.findFirst({ where: { id: parsed.data.contactId, tenantId } });
      if (!contact) return reply.status(400).send({ error: "Contato não encontrado" });
    }

    const deal = await prisma.deal.update({ where: { id }, data: parsed.data });
    return reply.send(deal);
  });

  // Move o deal pra outro estágio (ou só reordena dentro do mesmo estágio).
  // Bloqueia mover um deal já ganho/perdido — reabra primeiro via /status.
  app.patch("/deals/:id/stage", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = moveStageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const deal = await prisma.deal.findFirst({ where: { id, tenantId } });
    if (!deal) return reply.status(404).send({ error: "Deal não encontrado" });

    if (deal.status !== "open") {
      return reply.status(400).send({ error: "Deal já foi ganho/perdido — reabra antes de mover de estágio" });
    }

    const targetStage = await prisma.pipelineStage.findFirst({
      where: { id: parsed.data.stageId, pipelineId: deal.pipelineId },
    });
    if (!targetStage) return reply.status(400).send({ error: "Estágio não pertence ao pipeline desse deal" });

    let position = parsed.data.position;
    if (position === undefined) {
      const lastInStage = await prisma.deal.findFirst({
        where: { stageId: targetStage.id, id: { not: id } },
        orderBy: { position: "desc" },
      });
      position = (lastInStage?.position ?? -1) + 1;
    }

    const isSameStage = deal.stageId === targetStage.id;

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.deal.update({
        where: { id },
        data: { stageId: targetStage.id, position },
      });

      if (!isSameStage) {
        await tx.dealStageHistory.create({
          data: {
            dealId: id,
            fromStageId: deal.stageId,
            toStageId: targetStage.id,
            movedByUserId: request.auth.sub,
          },
        });
      }

      return result;
    });

    return reply.send(updated);
  });

  // Marca o deal como ganho/perdido, ou reabre (status: "open").
  app.patch("/deals/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const deal = await prisma.deal.findFirst({ where: { id, tenantId } });
    if (!deal) return reply.status(404).send({ error: "Deal não encontrado" });

    const { status, lostReason } = parsed.data;
    const now = new Date();

    const updated = await prisma.deal.update({
      where: { id },
      data: {
        status,
        wonAt: status === "won" ? now : null,
        lostAt: status === "lost" ? now : null,
        lostReason: status === "lost" ? lostReason ?? null : null,
      },
    });

    return reply.send(updated);
  });

  app.post("/deals/:id/tags", async (request, reply) => {
    const { id: dealId } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = attachTagSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId } });
    if (!deal) return reply.status(404).send({ error: "Deal não encontrado" });

    const resolved = await resolveTagId(tenantId, parsed.data);
    if ("error" in resolved) return reply.status(400).send({ error: resolved.error });

    const link = await prisma.dealTag.upsert({
      where: { dealId_tagId: { dealId, tagId: resolved.id } },
      create: { dealId, tagId: resolved.id },
      update: {},
      include: { tag: true },
    });

    return reply.status(201).send(link);
  });

  app.delete("/deals/:id/tags/:tagId", async (request, reply) => {
    const { id: dealId, tagId } = request.params as { id: string; tagId: string };
    const tenantId = request.auth.tenantId;

    const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId } });
    if (!deal) return reply.status(404).send({ error: "Deal não encontrado" });

    await prisma.dealTag.deleteMany({ where: { dealId, tagId } });
    return reply.status(204).send();
  });

  app.delete("/deals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.deal.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Deal não encontrado" });

    await prisma.$transaction([
      prisma.dealStageHistory.deleteMany({ where: { dealId: id } }),
      prisma.dealTag.deleteMany({ where: { dealId: id } }),
      prisma.deal.delete({ where: { id } }),
    ]);

    return reply.status(204).send();
  });
}

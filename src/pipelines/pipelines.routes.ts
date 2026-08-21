import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const stageInputSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  probability: z.number().int().min(0).max(100).optional(),
});

const createPipelineSchema = z.object({
  name: z.string().min(1),
  isDefault: z.boolean().optional(),
  stages: z.array(stageInputSchema).optional(),
});

const updatePipelineSchema = z.object({
  name: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
});

const reorderStagesSchema = z.object({
  stageIds: z.array(z.string().min(1)).min(1),
});

export async function pipelinesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Cria um pipeline. Se nenhum estágio for informado, cria um estágio
  // padrão "Novo" — um pipeline sem estágio não serve pra nada.
  app.post("/pipelines", async (request, reply) => {
    const parsed = createPipelineSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { name, isDefault, stages } = parsed.data;
    const tenantId = request.auth.tenantId;

    const stagesToCreate =
      stages && stages.length > 0 ? stages : [{ name: "Novo", color: undefined, probability: undefined }];

    const pipeline = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.pipeline.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.pipeline.create({
        data: {
          tenantId,
          name,
          isDefault: isDefault ?? false,
          stages: {
            create: stagesToCreate.map((s, index) => ({
              name: s.name,
              color: s.color,
              probability: s.probability,
              order: index,
            })),
          },
        },
        include: { stages: { orderBy: { order: "asc" } } },
      });
    });

    return reply.status(201).send(pipeline);
  });

  // Lista pipelines do tenant, com contagem de estágios e deals abertos.
  app.get("/pipelines", async (request, reply) => {
    const tenantId = request.auth.tenantId;
    const includeArchived = (request.query as Record<string, string>).includeArchived === "true";

    const pipelines = await prisma.pipeline.findMany({
      where: { tenantId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { stages: true, deals: true } },
      },
    });

    return reply.send(pipelines);
  });

  // Detalhe de um pipeline com seus estágios ordenados.
  app.get("/pipelines/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const pipeline = await prisma.pipeline.findFirst({
      where: { id, tenantId },
      include: {
        stages: {
          orderBy: { order: "asc" },
          include: { _count: { select: { deals: true } } },
        },
      },
    });

    if (!pipeline) return reply.status(404).send({ error: "Pipeline não encontrado" });
    return reply.send(pipeline);
  });

  // Visão de Kanban: estágios com os deals dentro de cada um, já ordenados
  // por posição — é o formato que o frontend consome direto pra montar o board.
  app.get("/pipelines/:id/board", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const pipeline = await prisma.pipeline.findFirst({
      where: { id, tenantId },
      include: {
        stages: {
          orderBy: { order: "asc" },
          include: {
            deals: {
              orderBy: { position: "asc" },
              include: {
                contact: { select: { id: true, name: true, phone: true } },
                assignedUser: { select: { id: true, name: true } },
                tags: { include: { tag: true } },
                _count: { select: { tasks: { where: { status: "pending" } } } },
              },
            },
          },
        },
      },
    });

    if (!pipeline) return reply.status(404).send({ error: "Pipeline não encontrado" });
    return reply.send(pipeline);
  });

  app.patch("/pipelines/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updatePipelineSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.pipeline.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Pipeline não encontrado" });

    const { name, isDefault } = parsed.data;

    const pipeline = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.pipeline.updateMany({
          where: { tenantId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.pipeline.update({
        where: { id },
        data: { name, isDefault },
      });
    });

    return reply.send(pipeline);
  });

  // Arquiva (não deleta de verdade — preserva histórico dos deals antigos).
  app.delete("/pipelines/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.pipeline.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Pipeline não encontrado" });

    await prisma.pipeline.update({ where: { id }, data: { archivedAt: new Date() } });
    return reply.status(204).send();
  });

  // --- Estágios ---

  app.post("/pipelines/:id/stages", async (request, reply) => {
    const { id: pipelineId } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = stageInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const pipeline = await prisma.pipeline.findFirst({ where: { id: pipelineId, tenantId } });
    if (!pipeline) return reply.status(404).send({ error: "Pipeline não encontrado" });

    const lastStage = await prisma.pipelineStage.findFirst({
      where: { pipelineId },
      orderBy: { order: "desc" },
    });

    const stage = await prisma.pipelineStage.create({
      data: {
        pipelineId,
        name: parsed.data.name,
        color: parsed.data.color,
        probability: parsed.data.probability,
        order: (lastStage?.order ?? -1) + 1,
      },
    });

    return reply.status(201).send(stage);
  });

  app.patch("/pipelines/:pipelineId/stages/:stageId", async (request, reply) => {
    const { pipelineId, stageId } = request.params as { pipelineId: string; stageId: string };
    const tenantId = request.auth.tenantId;

    const parsed = stageInputSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const stage = await prisma.pipelineStage.findFirst({
      where: { id: stageId, pipelineId, pipeline: { tenantId } },
    });
    if (!stage) return reply.status(404).send({ error: "Estágio não encontrado" });

    const updated = await prisma.pipelineStage.update({
      where: { id: stageId },
      data: parsed.data,
    });

    return reply.send(updated);
  });

  // Não deixa deletar estágio com deals dentro — força mover antes.
  app.delete("/pipelines/:pipelineId/stages/:stageId", async (request, reply) => {
    const { pipelineId, stageId } = request.params as { pipelineId: string; stageId: string };
    const tenantId = request.auth.tenantId;

    const stage = await prisma.pipelineStage.findFirst({
      where: { id: stageId, pipelineId, pipeline: { tenantId } },
      include: {
        _count: {
          select: { deals: true, historyFromStage: true, historyToStage: true },
        },
      },
    });
    if (!stage) return reply.status(404).send({ error: "Estágio não encontrado" });

    if (stage._count.deals > 0) {
      return reply.status(409).send({
        error: "Estágio tem deals associados — mova-os antes de deletar",
        dealsCount: stage._count.deals,
      });
    }

    // Mesmo sem deals atualmente, se algum deal já passou por esse estágio
    // (registrado no histórico), não deletamos — preserva o histórico intacto.
    if (stage._count.historyFromStage > 0 || stage._count.historyToStage > 0) {
      return reply.status(409).send({
        error: "Estágio já foi usado por algum deal no passado — não pode ser deletado, só um estágio nunca usado",
      });
    }

    await prisma.pipelineStage.delete({ where: { id: stageId } });
    return reply.status(204).send();
  });

  // Reordena os estágios de um pipeline. Recebe a lista completa de IDs
  // na nova ordem. Usa uma passada intermediária com valores negativos
  // pra não colidir com a constraint única (pipelineId, order) no meio do caminho.
  app.post("/pipelines/:id/stages/reorder", async (request, reply) => {
    const { id: pipelineId } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = reorderStagesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const pipeline = await prisma.pipeline.findFirst({
      where: { id: pipelineId, tenantId },
      include: { stages: true },
    });
    if (!pipeline) return reply.status(404).send({ error: "Pipeline não encontrado" });

    const existingIds = new Set(pipeline.stages.map((s) => s.id));
    const { stageIds } = parsed.data;

    if (stageIds.length !== existingIds.size || !stageIds.every((id) => existingIds.has(id))) {
      return reply.status(400).send({ error: "A lista precisa conter exatamente os estágios existentes do pipeline" });
    }

    await prisma.$transaction([
      ...stageIds.map((stageId, index) =>
        prisma.pipelineStage.update({ where: { id: stageId }, data: { order: -1 - index } })
      ),
      ...stageIds.map((stageId, index) =>
        prisma.pipelineStage.update({ where: { id: stageId }, data: { order: index } })
      ),
    ]);

    const updated = await prisma.pipelineStage.findMany({
      where: { pipelineId },
      orderBy: { order: "asc" },
    });

    return reply.send(updated);
  });
}

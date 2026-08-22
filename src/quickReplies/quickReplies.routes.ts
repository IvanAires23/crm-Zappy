import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const createQuickReplySchema = z.object({
  title: z.string().min(1).max(80),
  content: z.string().min(1).max(4000),
});

const updateQuickReplySchema = z.object({
  title: z.string().min(1).max(80).optional(),
  content: z.string().min(1).max(4000).optional(),
});

export async function quickRepliesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/quick-replies", async (request, reply) => {
    const tenantId = request.auth.tenantId;

    const quickReplies = await prisma.quickReply.findMany({
      where: { tenantId },
      orderBy: { title: "asc" },
    });

    return reply.send(quickReplies);
  });

  app.post("/quick-replies", async (request, reply) => {
    const parsed = createQuickReplySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { title, content } = parsed.data;

    const existing = await prisma.quickReply.findUnique({
      where: { tenantId_title: { tenantId, title } },
    });
    if (existing) {
      return reply.status(409).send({ error: "Já existe uma resposta rápida com esse título" });
    }

    const quickReply = await prisma.quickReply.create({ data: { tenantId, title, content } });
    return reply.status(201).send(quickReply);
  });

  app.patch("/quick-replies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateQuickReplySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.quickReply.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Resposta rápida não encontrada" });

    if (parsed.data.title && parsed.data.title !== existing.title) {
      const titleTaken = await prisma.quickReply.findUnique({
        where: { tenantId_title: { tenantId, title: parsed.data.title } },
      });
      if (titleTaken) return reply.status(409).send({ error: "Já existe uma resposta rápida com esse título" });
    }

    const quickReply = await prisma.quickReply.update({ where: { id }, data: parsed.data });
    return reply.send(quickReply);
  });

  app.delete("/quick-replies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.quickReply.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Resposta rápida não encontrada" });

    await prisma.quickReply.delete({ where: { id } });
    return reply.status(204).send();
  });
}

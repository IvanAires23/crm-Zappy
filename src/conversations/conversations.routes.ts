import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const paramsSchema = z.object({ id: z.string().min(1) });

export async function conversationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/conversations", async (request, reply) => {
    const conversations = await prisma.conversation.findMany({
      where: { tenantId: request.auth.tenantId },
      include: { contact: true },
      orderBy: { lastMessageAt: "desc" },
    });
    return reply.send(conversations);
  });

  app.get("/conversations/:id/messages", async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: parsed.data.id, tenantId: request.auth.tenantId },
    });
    if (!conversation) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
    });
    return reply.send(messages);
  });
}

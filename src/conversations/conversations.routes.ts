import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";
import { outboundQueue } from "../queue/queue.js";

const paramsSchema = z.object({ id: z.string().min(1) });
const sendMessageSchema = z.object({ text: z.string().min(1) });

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

  // Envia uma mensagem de texto livre nessa conversa: cria o registro local
  // como "pending" e enfileira pro worker de outbound processar de verdade.
  app.post("/conversations/:id/messages", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.flatten() });
    }
    const body = sendMessageSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
      include: { contact: true },
    });
    if (!conversation) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }

    const { text } = body.data;

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          tenantId: request.auth.tenantId,
          conversationId: conversation.id,
          direction: "outbound",
          type: "text",
          content: { text },
          status: "pending",
        },
      });

      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });

      return created;
    });

    await outboundQueue.add("send-message", {
      tenantId: request.auth.tenantId,
      messageId: message.id,
      to: conversation.contact.phone,
      text,
    });

    return reply.status(201).send(message);
  });
}

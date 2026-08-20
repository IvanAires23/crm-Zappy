import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";
import { outboundQueue } from "../queue/queue.js";

const createBroadcastSchema = z
  .object({
    templateId: z.string().min(1),
    tagId: z.string().min(1).optional(),
    contactIds: z.array(z.string().min(1)).optional(),
  })
  .refine((data) => Boolean(data.tagId) !== Boolean(data.contactIds?.length), {
    message: "Informe tagId OU contactIds (não os dois, não nenhum)",
  });

async function getOrCreateConversation(tenantId: string, contactId: string) {
  const existing = await prisma.conversation.findFirst({
    where: { tenantId, contactId, status: { not: "closed" } },
  });
  if (existing) return existing;

  return prisma.conversation.create({ data: { tenantId, contactId, status: "open" } });
}

export async function broadcastsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.post("/broadcasts", async (request, reply) => {
    const parsed = createBroadcastSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { templateId, tagId, contactIds } = parsed.data;

    const template = await prisma.template.findFirst({ where: { id: templateId, tenantId } });
    if (!template) return reply.status(400).send({ error: "Template não encontrado" });
    if (template.metaStatus !== "approved") {
      return reply.status(400).send({ error: "Só é possível disparar templates aprovados pela Meta" });
    }

    const contacts = tagId
      ? await prisma.contact.findMany({ where: { tenantId, tags: { some: { tagId } } } })
      : await prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } } });

    if (contacts.length === 0) {
      return reply.status(400).send({ error: "Nenhum contato encontrado para esse público" });
    }

    const broadcast = await prisma.broadcast.create({
      data: {
        tenantId,
        templateId,
        status: "sending",
        totalCount: contacts.length,
      },
    });

    for (const contact of contacts) {
      const conversation = await getOrCreateConversation(tenantId, contact.id);

      const message = await prisma.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          direction: "outbound",
          type: "template",
          content: { templateName: template.name, language: template.language },
          status: "pending",
        },
      });

      const recipient = await prisma.broadcastRecipient.create({
        data: { broadcastId: broadcast.id, contactId: contact.id, messageId: message.id },
      });

      await outboundQueue.add("send-broadcast", {
        tenantId,
        messageId: message.id,
        to: contact.phone,
        template: { name: template.name, languageCode: template.language },
        broadcastRecipientId: recipient.id,
      });
    }

    return reply.status(201).send(broadcast);
  });

  app.get("/broadcasts", async (request, reply) => {
    const tenantId = request.auth.tenantId;

    const broadcasts = await prisma.broadcast.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      include: { template: { select: { id: true, name: true } } },
    });

    return reply.send(broadcasts);
  });

  app.get("/broadcasts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenantId },
      include: {
        template: { select: { id: true, name: true } },
        recipients: {
          include: { contact: { select: { id: true, name: true, phone: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!broadcast) return reply.status(404).send({ error: "Disparo não encontrado" });
    return reply.send(broadcast);
  });
}

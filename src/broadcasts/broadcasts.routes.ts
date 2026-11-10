import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate, requirePermission } from "../auth/auth.plugin.js";
import { outboundQueue } from "../queue/queue.js";
import { buildContext } from "../automation/context.js";
import { getTenantProvider } from "../whatsapp/client.js";
import { renderTemplateText, resolveVariables } from "../templates/templateService.js";

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

  app.post("/broadcasts", { preHandler: requirePermission("broadcasts.manage") }, async (request, reply) => {
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
    // Template oficial só na Cloud API; modelo interno (ou qualquer um na
    // API não oficial) vai como texto, personalizado por contato.
    const provider = await getTenantProvider(tenantId);
    const asOfficialTemplate = template.type === "waba" && provider === "cloud_api";
    if (template.type === "internal" && provider === "cloud_api") {
      return reply.status(400).send({
        error: "Na API oficial, disparo em massa só com template aprovado pela Meta (modelo interno seria recusado fora da janela de 24h)",
      });
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

      const ctx = await buildContext(tenantId, "broadcast", { contactId: contact.id, conversationId: conversation.id });
      const values = resolveVariables(template, ctx);
      const text = renderTemplateText(template, ctx, values);
      const components = values.length
        ? [{ type: "body", parameters: values.map((v) => ({ type: "text", text: v || "-" })) }]
        : undefined;

      const message = await prisma.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          direction: "outbound",
          type: asOfficialTemplate ? "template" : "text",
          content: { templateName: template.name, language: template.language, text },
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
        ...(asOfficialTemplate
          ? { template: { name: template.name, languageCode: template.language, components } }
          : { text }),
        broadcastRecipientId: recipient.id,
      });
    }

    return reply.status(201).send(broadcast);
  });

  app.get("/broadcasts", { preHandler: requirePermission("broadcasts.manage") }, async (request, reply) => {
    const tenantId = request.auth.tenantId;

    const broadcasts = await prisma.broadcast.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      include: { template: { select: { id: true, name: true } } },
    });

    return reply.send(broadcasts);
  });

  app.get("/broadcasts/:id", { preHandler: requirePermission("broadcasts.manage") }, async (request, reply) => {
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

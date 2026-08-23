import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";
import { outboundQueue } from "../queue/queue.js";
import { publishRealtimeEvent } from "../realtime/bus.js";
import { uploadMedia, getTenantProvider } from "../whatsapp/client.js";
import { isWithinWindow, isMessagingRestricted } from "../whatsapp/window.js";

function whatsappTypeForMime(mimeType: string): "image" | "video" | "audio" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

const paramsSchema = z.object({ id: z.string().min(1) });
const sendMessageSchema = z.object({ text: z.string().min(1) });
const sendTemplateMessageSchema = z.object({
  templateId: z.string().min(1),
  variables: z.array(z.string()).optional(),
});
const listConversationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // "me" = minhas conversas; "unassigned" = sem atendente; qualquer outro
  // valor é tratado como um userId específico (transferência/supervisão).
  assignedUserId: z.string().optional(),
});
const assignConversationSchema = z.object({ userId: z.string().min(1).nullable() });
const createScheduledMessageSchema = z.object({
  text: z.string().min(1, "Mensagem é obrigatória"),
  scheduledFor: z.coerce.date().refine((d) => d.getTime() > Date.now(), "A data precisa ser no futuro"),
});
const scheduledMessageParamsSchema = z.object({ id: z.string().min(1), scheduledMessageId: z.string().min(1) });
const listMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Mesma lógica que o frontend usa pra renderizar uma mensagem dentro da
// conversa, só que resumida numa linha — é o que aparece embaixo do nome
// do contato na lista, tipo a prévia do WhatsApp Web.
function extractMessagePreview(message: { direction: string; type: string; content: unknown } | undefined): string | null {
  if (!message) return null;
  const content = message.content as Record<string, unknown> | null;
  if (!content) return null;

  if (message.direction === "outbound") {
    return typeof content.text === "string" ? content.text : `[${message.type}]`;
  }

  if (message.type === "text") {
    const text = content.text as { body?: string } | undefined;
    return text?.body ?? null;
  }
  return `[${message.type}]`;
}

export async function conversationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Paginação por cursor (id da última conversa já carregada) — sem isso,
  // uma conta com milhares de conversas carrega tudo de uma vez na lista.
  app.get("/conversations", async (request, reply) => {
    const parsed = listConversationsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const { cursor, limit, assignedUserId } = parsed.data;

    const assignedFilter =
      assignedUserId === "me"
        ? { assignedUserId: request.auth.sub }
        : assignedUserId === "unassigned"
          ? { assignedUserId: null }
          : assignedUserId
            ? { assignedUserId }
            : {};

    const conversations = await prisma.conversation.findMany({
      where: { tenantId: request.auth.tenantId, ...assignedFilter },
      include: {
        contact: true,
        assignedUser: { select: { id: true, name: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = conversations.length > limit;
    const page = hasMore ? conversations.slice(0, limit) : conversations;

    // Uma consulta só pro tenant inteiro, não por conversa — a janela de
    // 24h só existe pra Cloud API oficial (ver isMessagingRestricted).
    const provider = await getTenantProvider(request.auth.tenantId);

    const result = page.map(({ messages, ...conversation }) => {
      const lastMessage = messages[0];
      const unread =
        lastMessage?.direction === "inbound" &&
        (!conversation.lastReadAt || conversation.lastReadAt < conversation.lastMessageAt);

      return {
        ...conversation,
        lastMessagePreview: extractMessagePreview(lastMessage),
        lastMessageDirection: lastMessage?.direction ?? null,
        unread,
        withinWindow: !isMessagingRestricted(provider, conversation.lastInboundMessageAt),
      };
    });

    return reply.send({ conversations: result, nextCursor: hasMore ? page[page.length - 1].id : null });
  });

  // Paginação por cursor (id da mensagem mais antiga já carregada) — busca
  // sempre as mais recentes primeiro, e páginas seguintes vão carregando
  // histórico mais antigo conforme o atendente rola pra cima no chat.
  app.get("/conversations/:id/messages", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const query = listMessagesQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: firstZodMessage(query.error) });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
    });
    if (!conversation) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }

    const { cursor, limit } = query.data;

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const ordered = page.slice().reverse(); // volta pra ordem cronológica (mais antiga primeiro)

    return reply.send({ messages: ordered, nextCursor: hasMore ? page[page.length - 1].id : null });
  });

  // Envia uma mensagem de texto livre nessa conversa: cria o registro local
  // como "pending" e enfileira pro worker de outbound processar de verdade.
  app.post("/conversations/:id/messages", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = sendMessageSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
      include: { contact: true },
    });
    if (!conversation) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }
    const provider = await getTenantProvider(request.auth.tenantId);
    if (isMessagingRestricted(provider, conversation.lastInboundMessageAt)) {
      return reply.status(409).send({
        error: "Fora da janela de 24h — envie um template pra reabrir a conversa",
      });
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

    // Quem enviou já recebe a mensagem na resposta HTTP — isso é pra
    // outros atendentes com a mesma conversa aberta em outra aba/sessão
    // verem em tempo real também.
    await publishRealtimeEvent({
      tenantId: request.auth.tenantId,
      event: "message:new",
      data: { conversationId: conversation.id, message },
    });

    return reply.status(201).send(message);
  });

  // Envia um template aprovado nessa conversa — funciona mesmo fora da
  // janela de 24h (é assim que a Meta permite reabrir uma conversa parada),
  // diferente do texto livre da rota acima.
  app.post("/conversations/:id/template-messages", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = sendTemplateMessageSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
      include: { contact: true },
    });
    if (!conversation) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }

    const template = await prisma.template.findFirst({
      where: { id: body.data.templateId, tenantId: request.auth.tenantId },
    });
    if (!template) {
      return reply.status(404).send({ error: "Template não encontrado" });
    }
    if (template.metaStatus !== "approved") {
      return reply.status(409).send({ error: "Esse template ainda não foi aprovado pela Meta" });
    }

    const variables = body.data.variables ?? [];
    // Guarda o texto já substituído localmente pra prévia/histórico — o que
    // vai pra Meta são os "components" com os parâmetros separados.
    const renderedText = template.bodyText.replace(
      /\{\{(\d+)\}\}/g,
      (match, index) => variables[Number(index) - 1] ?? match
    );
    const components =
      variables.length > 0
        ? [{ type: "body", parameters: variables.map((text) => ({ type: "text", text })) }]
        : undefined;

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          tenantId: request.auth.tenantId,
          conversationId: conversation.id,
          direction: "outbound",
          type: "template",
          content: { templateName: template.name, text: renderedText },
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
      template: { name: template.name, languageCode: template.language, components },
    });

    await publishRealtimeEvent({
      tenantId: request.auth.tenantId,
      event: "message:new",
      data: { conversationId: conversation.id, message },
    });

    return reply.status(201).send(message);
  });

  // Envia mídia (imagem/áudio/vídeo/documento) nessa conversa — multipart,
  // um arquivo por request (a legenda, se houver, precisa vir num campo
  // "caption" ANTES do arquivo no FormData — o parser é um stream e só
  // enxerga campos que já passaram quando o arquivo é lido). Sujeito à
  // mesma janela de 24h do texto livre.
  app.post("/conversations/:id/media-messages", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
      include: { contact: true },
    });
    if (!conversation) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }
    if (!isWithinWindow(conversation.lastInboundMessageAt)) {
      return reply.status(409).send({
        error: "Fora da janela de 24h — envie um template pra reabrir a conversa",
      });
    }

    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: "Nenhum arquivo enviado" });
    }

    const buffer = await file.toBuffer();
    const mimeType = file.mimetype;
    const filename = file.filename;
    const captionField = (file.fields as Record<string, { value?: unknown }>).caption;
    const caption = typeof captionField?.value === "string" && captionField.value.length > 0 ? captionField.value : undefined;
    const type = whatsappTypeForMime(mimeType);

    let uploaded: { id: string };
    try {
      uploaded = await uploadMedia(request.auth.tenantId, buffer, mimeType, filename);
    } catch (err) {
      request.log.error({ err }, "Falha ao subir mídia pra Meta");
      return reply.status(502).send({ error: "Não foi possível enviar o arquivo pro WhatsApp" });
    }

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          tenantId: request.auth.tenantId,
          conversationId: conversation.id,
          direction: "outbound",
          type,
          content: { id: uploaded.id, mime_type: mimeType, filename, caption: caption ?? null },
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
      media: { type, id: uploaded.id, caption, filename },
    });

    await publishRealtimeEvent({
      tenantId: request.auth.tenantId,
      event: "message:new",
      data: { conversationId: conversation.id, message },
    });

    return reply.status(201).send(message);
  });

  // Agenda uma mensagem de texto pra essa conversa — o envio de verdade
  // acontece no tick do scheduler (automation.worker.ts), que checa a
  // janela de 24h de novo no momento do envio (pode ter fechado entre o
  // agendamento e a hora marcada).
  app.post("/conversations/:id/scheduled-messages", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = createScheduledMessageSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
    });
    if (!conversation) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }

    const scheduled = await prisma.scheduledMessage.create({
      data: {
        tenantId: request.auth.tenantId,
        conversationId: conversation.id,
        text: body.data.text,
        scheduledFor: body.data.scheduledFor,
        createdByUserId: request.auth.sub,
      },
    });

    return reply.status(201).send(scheduled);
  });

  // Só as pendentes — enviadas/canceladas/falhadas ficam no histórico da
  // mensagem de verdade (ou some da lista), não precisa reaparecer aqui.
  app.get("/conversations/:id/scheduled-messages", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }

    const scheduled = await prisma.scheduledMessage.findMany({
      where: { conversationId: params.data.id, tenantId: request.auth.tenantId, status: "pending" },
      orderBy: { scheduledFor: "asc" },
    });

    return reply.send(scheduled);
  });

  app.delete("/conversations/:id/scheduled-messages/:scheduledMessageId", async (request, reply) => {
    const params = scheduledMessageParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }

    const existing = await prisma.scheduledMessage.findFirst({
      where: { id: params.data.scheduledMessageId, conversationId: params.data.id, tenantId: request.auth.tenantId },
    });
    if (!existing) {
      return reply.status(404).send({ error: "Mensagem agendada não encontrada" });
    }
    if (existing.status !== "pending") {
      return reply.status(409).send({ error: "Essa mensagem já foi enviada ou cancelada" });
    }

    await prisma.scheduledMessage.update({ where: { id: existing.id }, data: { status: "cancelled" } });
    return reply.status(204).send();
  });

  // Marca a conversa como lida — "não lida" é derivado no GET /conversations
  // (última mensagem inbound mais recente que lastReadAt). É um marcador
  // único por conversa, não por usuário: qualquer atendente que abrir já
  // limpa o "não lida" pra equipe toda, independente de quem é o atribuído.
  app.post("/conversations/:id/read", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
    });
    if (!conversation) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastReadAt: new Date() },
    });

    await publishRealtimeEvent({
      tenantId: request.auth.tenantId,
      event: "conversation:read",
      data: { conversationId: conversation.id, lastReadAt: updated.lastReadAt },
    });

    return reply.send({ lastReadAt: updated.lastReadAt });
  });

  // Atribui/transfere/desatribui uma conversa — qualquer atendente pode
  // (não é admin-only: é assim que o time se organiza no dia a dia,
  // pegando conversas pra si ou passando pra outro colega).
  app.patch("/conversations/:id/assign", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = assignConversationSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
    });
    if (!conversation) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }

    if (body.data.userId) {
      const assignee = await prisma.user.findFirst({
        where: { id: body.data.userId, tenantId: request.auth.tenantId, active: true },
      });
      if (!assignee) {
        return reply.status(404).send({ error: "Usuário não encontrado" });
      }
    }

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { assignedUserId: body.data.userId },
      include: { assignedUser: { select: { id: true, name: true } } },
    });

    await publishRealtimeEvent({
      tenantId: request.auth.tenantId,
      event: "conversation:assigned",
      data: { conversationId: conversation.id, assignedUserId: updated.assignedUserId, assignedUser: updated.assignedUser },
    });

    return reply.send({ assignedUserId: updated.assignedUserId, assignedUser: updated.assignedUser });
  });
}

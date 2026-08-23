import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";
import { outboundQueue } from "../queue/queue.js";
import { publishRealtimeEvent } from "../realtime/bus.js";

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

const paramsSchema = z.object({ id: z.string().min(1) });
const sendMessageSchema = z.object({ text: z.string().min(1) });
const listConversationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
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
    const { cursor, limit } = parsed.data;

    const conversations = await prisma.conversation.findMany({
      where: { tenantId: request.auth.tenantId },
      include: {
        contact: true,
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = conversations.length > limit;
    const page = hasMore ? conversations.slice(0, limit) : conversations;

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

  // Marca a conversa como lida — "não lida" é derivado no GET /conversations
  // (última mensagem inbound mais recente que lastReadAt), não há
  // contagem por usuário ainda (ver CLAUDE.md, lacuna de atribuição).
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
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const createNoteSchema = z.object({
  contactId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  content: z.string().min(1).max(4000),
});

const updateNoteSchema = z.object({
  content: z.string().min(1).max(4000),
});

const listQuerySchema = z.object({
  contactId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
});

export async function notesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Notas são sempre por contato (ficam visíveis em qualquer conversa com
  // ele) — passar conversationId aqui é só um atalho: resolve o contactId
  // daquela conversa e lista as notas dele.
  app.get("/notes", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    let { contactId } = parsed.data;
    const { conversationId } = parsed.data;

    if (!contactId && conversationId) {
      const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
      if (!conversation) return reply.status(400).send({ error: "Conversa não encontrada" });
      contactId = conversation.contactId;
    }

    if (!contactId) {
      return reply.status(400).send({ error: "Informe contactId ou conversationId" });
    }

    const notes = await prisma.note.findMany({
      where: { tenantId, contactId },
      orderBy: { createdAt: "desc" },
      include: { authorUser: { select: { id: true, name: true } } },
    });

    return reply.send(notes);
  });

  app.post("/notes", async (request, reply) => {
    const parsed = createNoteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { contactId, conversationId, content } = parsed.data;

    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
    if (!contact) return reply.status(400).send({ error: "Contato não encontrado" });

    if (conversationId) {
      const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
      if (!conversation) return reply.status(400).send({ error: "Conversa não encontrada" });
    }

    const note = await prisma.note.create({
      data: { tenantId, contactId, conversationId, content, authorUserId: request.auth.sub },
      include: { authorUser: { select: { id: true, name: true } } },
    });

    return reply.status(201).send(note);
  });

  app.patch("/notes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateNoteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.note.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Nota não encontrada" });

    const note = await prisma.note.update({
      where: { id },
      data: { content: parsed.data.content },
      include: { authorUser: { select: { id: true, name: true } } },
    });

    return reply.send(note);
  });

  app.delete("/notes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.note.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Nota não encontrada" });

    await prisma.note.delete({ where: { id } });
    return reply.status(204).send();
  });
}

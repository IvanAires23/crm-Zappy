import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";
import { resolveTagId } from "../tags/findOrCreateTag.js";
import { emitAutomationEvent } from "../automation/emit.js";

// Nota: não existe rota de criação/edição de Contact aqui de propósito —
// contatos são criados pelo webhook worker a partir de mensagens recebidas.
// Isso aqui é só o mínimo de leitura + gestão de tags que o módulo de
// Tags precisa pra funcionar via API.

const listQuerySchema = z.object({
  search: z.string().optional(),
  tagId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const attachTagSchema = z.object({
  tagId: z.string().min(1).optional(),
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export async function contactsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/contacts", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { search, tagId, page, pageSize } = parsed.data;

    const where = {
      tenantId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { phone: { contains: search } },
            ],
          }
        : {}),
      ...(tagId ? { tags: { some: { tagId } } } : {}),
    };

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          tags: { include: { tag: true } },
          _count: { select: { deals: true, conversations: true } },
        },
      }),
      prisma.contact.count({ where }),
    ]);

    return reply.send({ contacts, total, page, pageSize });
  });

  app.get("/contacts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const contact = await prisma.contact.findFirst({
      where: { id, tenantId },
      include: {
        tags: { include: { tag: true } },
        deals: {
          include: { stage: { select: { id: true, name: true } }, pipeline: { select: { id: true, name: true } } },
        },
        conversations: { select: { id: true, status: true, lastMessageAt: true } },
      },
    });

    if (!contact) return reply.status(404).send({ error: "Contato não encontrado" });
    return reply.send(contact);
  });

  app.post("/contacts/:id/tags", async (request, reply) => {
    const { id: contactId } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = attachTagSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
    if (!contact) return reply.status(404).send({ error: "Contato não encontrado" });

    const resolved = await resolveTagId(tenantId, parsed.data);
    if ("error" in resolved) return reply.status(400).send({ error: resolved.error });

    const link = await prisma.contactTag.upsert({
      where: { contactId_tagId: { contactId, tagId: resolved.id } },
      create: { contactId, tagId: resolved.id },
      update: {},
      include: { tag: true },
    });

    await emitAutomationEvent(tenantId, "contact.tag_added", {
      contactId,
      contactPhone: contact.phone,
      contactName: contact.name,
      tagId: link.tag.id,
      tagName: link.tag.name,
    });

    return reply.status(201).send(link);
  });

  app.delete("/contacts/:id/tags/:tagId", async (request, reply) => {
    const { id: contactId, tagId } = request.params as { id: string; tagId: string };
    const tenantId = request.auth.tenantId;

    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
    if (!contact) return reply.status(404).send({ error: "Contato não encontrado" });

    await prisma.contactTag.deleteMany({ where: { contactId, tagId } });
    return reply.status(204).send();
  });
}

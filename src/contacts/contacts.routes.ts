import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";
import { resolveTagId } from "../tags/findOrCreateTag.js";
import { emitAutomationEvent } from "../automation/emit.js";
import { getTenantProvider } from "../whatsapp/client.js";
import { isMessagingRestricted } from "../whatsapp/window.js";

// Nota: a maior parte dos contatos é criada pelo webhook worker a partir de
// mensagens recebidas — a rota de criação abaixo é só pro atendente
// cadastrar manualmente um contato que já existe fora do CRM (ex: veio de
// outro canal) e conseguir puxar conversa com ele.

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

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

const createContactSchema = z.object({
  name: z.string().trim().min(1, "Nome é obrigatório").max(120),
  // Aceita o telefone com ou sem formatação (espaços, parênteses, +) e
  // guarda só os dígitos — mesmo formato que o webhook grava a partir do
  // msg.from da Meta (ver CLAUDE.md, "Contato compartilhado entre providers").
  phone: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => /^\d{8,15}$/.test(v), "Telefone inválido — inclua DDI e DDD, só números"),
});

export async function contactsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Cadastro manual: nome + telefone e já abre (ou reaproveita) uma
  // conversa, pra dar pra mandar mensagem na hora — sem depender de uma
  // mensagem inbound pra criar o contato primeiro.
  app.post("/contacts", async (request, reply) => {
    const parsed = createContactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const tenantId = request.auth.tenantId;
    const { name, phone } = parsed.data;

    let contact = await prisma.contact.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
    const isNewContact = !contact;
    if (!contact) {
      contact = await prisma.contact.create({ data: { tenantId, phone, name } });
    }

    let conversation = await prisma.conversation.findFirst({
      where: { tenantId, contactId: contact.id, status: { not: "closed" } },
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({ data: { tenantId, contactId: contact.id, status: "open" } });
    }

    const provider = await getTenantProvider(tenantId);

    return reply.status(isNewContact ? 201 : 200).send({
      contact,
      conversation: {
        ...conversation,
        contact,
        lastMessagePreview: null,
        lastMessageDirection: null,
        unread: false,
        withinWindow: !isMessagingRestricted(provider, conversation.lastInboundMessageAt),
        assignedUser: null,
      },
      alreadyExisted: !isNewContact,
    });
  });

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

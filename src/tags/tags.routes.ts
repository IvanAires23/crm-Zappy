import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate, dealScope, requireAnyPermission, requirePermission } from "../auth/auth.plugin.js";
import { slugifyTagName } from "./slugify.js";
import { resolveTagId } from "./findOrCreateTag.js";
import { emitAutomationEvent } from "../automation/emit.js";

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

// Ação em massa (estilo Kommo: seleciona vários leads/contatos e
// "Editar tags"). Etiquetas por nome são criadas na hora, igual ao input
// individual.
const bulkSchema = z
  .object({
    action: z.enum(["add", "remove"]),
    tagIds: z.array(z.string().min(1)).max(50).optional(),
    tagNames: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
    contactIds: z.array(z.string().min(1)).max(1000).optional(),
    dealIds: z.array(z.string().min(1)).max(1000).optional(),
  })
  .refine((d) => (d.tagIds?.length ?? 0) + (d.tagNames?.length ?? 0) > 0, { message: "Escolha pelo menos uma etiqueta" })
  .refine((d) => (d.contactIds?.length ?? 0) + (d.dealIds?.length ?? 0) > 0, {
    message: "Escolha pelo menos um contato ou oportunidade",
  });

const mergeSchema = z.object({ intoTagId: z.string().min(1) });

const createTagSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const updateTagSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export async function tagsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.post("/tags", { preHandler: requireAnyPermission("tags.manage", "contacts.edit", "deals.edit") }, async (request, reply) => {
    const parsed = createTagSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const tenantId = request.auth.tenantId;
    const { name, color } = parsed.data;
    const slug = slugifyTagName(name);

    const existing = await prisma.tag.findUnique({ where: { tenantId_slug: { tenantId, slug } } });
    if (existing) {
      return reply.status(409).send({ error: "Já existe uma tag com esse nome", tag: existing });
    }

    const tag = await prisma.tag.create({
      data: { tenantId, name, slug, color: color ?? "#6b7280" },
    });

    return reply.status(201).send(tag);
  });

  app.get("/tags", async (request, reply) => {
    const tenantId = request.auth.tenantId;
    const search = typeof (request.query as { search?: unknown }).search === "string"
      ? ((request.query as { search: string }).search).trim()
      : "";

    const tags = await prisma.tag.findMany({
      where: { tenantId, ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}) },
      orderBy: { name: "asc" },
      include: { _count: { select: { contacts: true, deals: true } } },
    });

    return reply.send(tags);
  });

  app.patch("/tags/:id", { preHandler: requirePermission("tags.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateTagSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }

    const existing = await prisma.tag.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Tag não encontrada" });

    const data: { name?: string; slug?: string; color?: string } = {};
    if (parsed.data.color) data.color = parsed.data.color;

    if (parsed.data.name) {
      const slug = slugifyTagName(parsed.data.name);
      const collision = await prisma.tag.findFirst({
        where: { tenantId, slug, id: { not: id } },
      });
      if (collision) {
        return reply.status(409).send({ error: "Já existe outra tag com esse nome" });
      }
      data.name = parsed.data.name;
      data.slug = slug;
    }

    const tag = await prisma.tag.update({ where: { id }, data });
    return reply.send(tag);
  });

  // Deleta a tag e desanexa de todo mundo — tag é só rótulo, não tem
  // histórico a preservar (diferente de estágio de pipeline).
  app.delete("/tags/:id", { preHandler: requirePermission("tags.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.tag.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Tag não encontrada" });

    await prisma.$transaction([
      prisma.contactTag.deleteMany({ where: { tagId: id } }),
      prisma.dealTag.deleteMany({ where: { tagId: id } }),
      prisma.tag.delete({ where: { id } }),
    ]);

    return reply.status(204).send();
  });

  app.post("/tags/bulk", { preHandler: requireAnyPermission("tags.manage", "contacts.edit", "deals.edit") }, async (request, reply) => {
    const parsed = bulkSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    const tenantId = request.auth.tenantId;
    const { action, contactIds = [], dealIds = [] } = parsed.data;
    const perms = request.auth.permissions;
    if (contactIds.length && !perms.has("contacts.edit")) {
      return reply.status(403).send({ error: "Você não tem permissão para editar contatos" });
    }
    if (dealIds.length && !perms.has("deals.edit")) {
      return reply.status(403).send({ error: "Você não tem permissão para editar oportunidades" });
    }

    const tagIds = new Set<string>();
    for (const tagId of parsed.data.tagIds ?? []) {
      const r = await resolveTagId(tenantId, { tagId });
      if ("error" in r) return reply.status(400).send({ error: r.error });
      tagIds.add(r.id);
    }
    for (const name of parsed.data.tagNames ?? []) {
      if (action === "remove") {
        const existing = await prisma.tag.findUnique({ where: { tenantId_slug: { tenantId, slug: slugifyTagName(name) } } });
        if (existing) tagIds.add(existing.id);
        continue;
      }
      const r = await resolveTagId(tenantId, { name });
      if ("error" in r) return reply.status(400).send({ error: r.error });
      tagIds.add(r.id);
    }
    const tags = await prisma.tag.findMany({ where: { tenantId, id: { in: [...tagIds] } } });

    const contacts = contactIds.length
      ? await prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } }, include: { tags: true } })
      : [];
    const deals = dealIds.length
      ? await prisma.deal.findMany({ where: { tenantId, id: { in: dealIds }, ...dealScope(request) }, include: { tags: true } })
      : [];

    let changed = 0;
    for (const contact of contacts) {
      const has = new Set(contact.tags.map((t) => t.tagId));
      for (const tag of tags) {
        if (action === "add" && !has.has(tag.id)) {
          await prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
          await emitAutomationEvent(tenantId, "contact.tag_added", {
            contactId: contact.id, contactPhone: contact.phone, contactName: contact.name, tagId: tag.id, tagName: tag.name,
          });
          changed++;
        } else if (action === "remove" && has.has(tag.id)) {
          await prisma.contactTag.deleteMany({ where: { contactId: contact.id, tagId: tag.id } });
          await emitAutomationEvent(tenantId, "contact.tag_removed", {
            contactId: contact.id, contactPhone: contact.phone, contactName: contact.name, tagId: tag.id, tagName: tag.name,
          });
          changed++;
        }
      }
    }
    for (const deal of deals) {
      const has = new Set(deal.tags.map((t) => t.tagId));
      for (const tag of tags) {
        if (action === "add" && !has.has(tag.id)) {
          await prisma.dealTag.create({ data: { dealId: deal.id, tagId: tag.id } });
          await emitAutomationEvent(tenantId, "deal.tag_added", { dealId: deal.id, tagId: tag.id, tagName: tag.name });
          changed++;
        } else if (action === "remove" && has.has(tag.id)) {
          await prisma.dealTag.deleteMany({ where: { dealId: deal.id, tagId: tag.id } });
          await emitAutomationEvent(tenantId, "deal.tag_removed", { dealId: deal.id, tagId: tag.id, tagName: tag.name });
          changed++;
        }
      }
    }

    return reply.send({ changed, contacts: contacts.length, deals: deals.length, tags: tags.length });
  });

  // Mescla uma etiqueta em outra (ex: "Cliente VIP" e "vip" duplicadas):
  // quem tinha a de origem passa a ter a de destino, e a origem some.
  app.post("/tags/:id/merge", { preHandler: requirePermission("tags.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;
    const parsed = mergeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    if (parsed.data.intoTagId === id) return reply.status(400).send({ error: "Escolha uma etiqueta diferente" });

    const [source, target] = await Promise.all([
      prisma.tag.findFirst({ where: { id, tenantId } }),
      prisma.tag.findFirst({ where: { id: parsed.data.intoTagId, tenantId } }),
    ]);
    if (!source || !target) return reply.status(404).send({ error: "Etiqueta não encontrada" });

    const [contactLinks, dealLinks] = await Promise.all([
      prisma.contactTag.findMany({ where: { tagId: id } }),
      prisma.dealTag.findMany({ where: { tagId: id } }),
    ]);

    await prisma.$transaction([
      prisma.contactTag.createMany({
        data: contactLinks.map((l) => ({ contactId: l.contactId, tagId: target.id })),
        skipDuplicates: true,
      }),
      prisma.dealTag.createMany({
        data: dealLinks.map((l) => ({ dealId: l.dealId, tagId: target.id })),
        skipDuplicates: true,
      }),
      prisma.contactTag.deleteMany({ where: { tagId: id } }),
      prisma.dealTag.deleteMany({ where: { tagId: id } }),
      prisma.tag.delete({ where: { id } }),
    ]);

    const merged = await prisma.tag.findUnique({
      where: { id: target.id },
      include: { _count: { select: { contacts: true, deals: true } } },
    });
    return reply.send(merged);
  });
}

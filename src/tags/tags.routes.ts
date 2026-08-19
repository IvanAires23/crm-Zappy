import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";
import { slugifyTagName } from "./slugify.js";

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

  app.post("/tags", async (request, reply) => {
    const parsed = createTagSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
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

    const tags = await prisma.tag.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
      include: { _count: { select: { contacts: true, deals: true } } },
    });

    return reply.send(tags);
  });

  app.patch("/tags/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateTagSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
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
  app.delete("/tags/:id", async (request, reply) => {
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
}

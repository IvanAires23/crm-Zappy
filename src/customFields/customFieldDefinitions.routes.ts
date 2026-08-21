import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const createDefinitionSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(["text", "number", "date"]).default("text"),
});

export async function customFieldDefinitionsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/custom-fields", async (request, reply) => {
    const tenantId = request.auth.tenantId;

    const definitions = await prisma.dealCustomFieldDefinition.findMany({
      where: { tenantId },
      orderBy: { order: "asc" },
    });

    return reply.send(definitions);
  });

  app.post("/custom-fields", async (request, reply) => {
    const parsed = createDefinitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { name, type } = parsed.data;

    const existing = await prisma.dealCustomFieldDefinition.findUnique({
      where: { tenantId_name: { tenantId, name } },
    });
    if (existing) {
      return reply.status(409).send({ error: "Já existe um campo com esse nome" });
    }

    const lastField = await prisma.dealCustomFieldDefinition.findFirst({
      where: { tenantId },
      orderBy: { order: "desc" },
    });

    const definition = await prisma.dealCustomFieldDefinition.create({
      data: { tenantId, name, type, order: (lastField?.order ?? -1) + 1 },
    });

    return reply.status(201).send(definition);
  });

  app.delete("/custom-fields/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.dealCustomFieldDefinition.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Campo não encontrado" });

    await prisma.dealCustomFieldDefinition.delete({ where: { id } });
    return reply.status(204).send();
  });
}

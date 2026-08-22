import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const SELECT_TYPES = ["select", "multi_select"] as const;

const optionsSchema = z.array(z.string().trim().min(1).max(50)).max(50);

function normalizeOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const option of options) {
    if (!seen.has(option)) {
      seen.add(option);
      result.push(option);
    }
  }
  return result;
}

const createDefinitionSchema = z
  .object({
    name: z.string().min(1).max(50),
    type: z.enum(["text", "number", "date", "select", "multi_select"]).default("text"),
    options: optionsSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (SELECT_TYPES.includes(data.type as (typeof SELECT_TYPES)[number]) && !data.options?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Informe ao menos uma opção",
      });
    }
  });

const updateDefinitionSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  options: optionsSchema.optional(),
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
    const { name, type, options } = parsed.data;

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

    const isSelectType = SELECT_TYPES.includes(type as (typeof SELECT_TYPES)[number]);

    const definition = await prisma.dealCustomFieldDefinition.create({
      data: {
        tenantId,
        name,
        type,
        options: isSelectType ? normalizeOptions(options ?? []) : [],
        order: (lastField?.order ?? -1) + 1,
      },
    });

    return reply.status(201).send(definition);
  });

  app.patch("/custom-fields/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateDefinitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.dealCustomFieldDefinition.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Campo não encontrado" });

    const isSelectType = SELECT_TYPES.includes(existing.type as (typeof SELECT_TYPES)[number]);
    if (isSelectType && parsed.data.options && parsed.data.options.length === 0) {
      return reply.status(400).send({ error: "Informe ao menos uma opção" });
    }

    if (parsed.data.name && parsed.data.name !== existing.name) {
      const nameTaken = await prisma.dealCustomFieldDefinition.findUnique({
        where: { tenantId_name: { tenantId, name: parsed.data.name } },
      });
      if (nameTaken) return reply.status(409).send({ error: "Já existe um campo com esse nome" });
    }

    const definition = await prisma.dealCustomFieldDefinition.update({
      where: { id },
      data: {
        name: parsed.data.name,
        options:
          isSelectType && parsed.data.options ? normalizeOptions(parsed.data.options) : undefined,
      },
    });

    return reply.send(definition);
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

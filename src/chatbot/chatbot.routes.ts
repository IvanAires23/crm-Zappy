import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

const paramsSchema = z.object({ id: z.string().min(1) });

const createRuleSchema = z.object({
  keyword: z.string().min(1, "Palavra-chave é obrigatória").max(80),
  replyText: z.string().min(1, "Resposta é obrigatória").max(4000),
});

const updateRuleSchema = z.object({
  keyword: z.string().min(1).max(80).optional(),
  replyText: z.string().min(1).max(4000).optional(),
  isActive: z.boolean().optional(),
});

export async function chatbotRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/chatbot-rules", async (request, reply) => {
    const rules = await prisma.chatbotRule.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { keyword: "asc" },
    });
    return reply.send(rules);
  });

  app.post("/chatbot-rules", async (request, reply) => {
    const parsed = createRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }

    const rule = await prisma.chatbotRule.create({
      data: { tenantId: request.auth.tenantId, ...parsed.data },
    });
    return reply.status(201).send(rule);
  });

  app.patch("/chatbot-rules/:id", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    const body = updateRuleSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const existing = await prisma.chatbotRule.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
    });
    if (!existing) return reply.status(404).send({ error: "Regra não encontrada" });

    const rule = await prisma.chatbotRule.update({ where: { id: existing.id }, data: body.data });
    return reply.send(rule);
  });

  app.delete("/chatbot-rules/:id", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }

    const existing = await prisma.chatbotRule.findFirst({
      where: { id: params.data.id, tenantId: request.auth.tenantId },
    });
    if (!existing) return reply.status(404).send({ error: "Regra não encontrada" });

    await prisma.chatbotRule.delete({ where: { id: existing.id } });
    return reply.status(204).send();
  });
}

import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const createWebhookSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  events: z.array(z.string()).optional(),
});

const updateWebhookSchema = z.object({
  name: z.string().min(1).optional(),
  url: z.string().url().optional(),
  events: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

export async function automationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Gera o secret aqui — só é devolvido por completo na criação, igual
  // qualquer API key. Depois disso, é usado internamente pra assinar
  // o payload (o tenant precisa dele configurado no lado que recebe).
  app.post("/automation/webhooks", async (request, reply) => {
    const parsed = createWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const secret = crypto.randomBytes(24).toString("hex");

    const webhook = await prisma.automationWebhook.create({
      data: {
        tenantId,
        name: parsed.data.name,
        url: parsed.data.url,
        events: parsed.data.events ?? [],
        secret,
      },
    });

    return reply.status(201).send(webhook);
  });

  app.get("/automation/webhooks", async (request, reply) => {
    const tenantId = request.auth.tenantId;

    const webhooks = await prisma.automationWebhook.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });

    return reply.send(webhooks);
  });

  app.patch("/automation/webhooks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const existing = await prisma.automationWebhook.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Webhook não encontrado" });

    const webhook = await prisma.automationWebhook.update({ where: { id }, data: parsed.data });
    return reply.send(webhook);
  });

  app.delete("/automation/webhooks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const existing = await prisma.automationWebhook.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Webhook não encontrado" });

    await prisma.$transaction([
      prisma.automationDelivery.deleteMany({ where: { webhookId: id } }),
      prisma.automationWebhook.delete({ where: { id } }),
    ]);

    return reply.status(204).send();
  });

  // Histórico de entregas — pra debugar automação sem adivinhar se o
  // outro lado (n8n) recebeu o evento.
  app.get("/automation/webhooks/:id/deliveries", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const webhook = await prisma.automationWebhook.findFirst({ where: { id, tenantId } });
    if (!webhook) return reply.status(404).send({ error: "Webhook não encontrado" });

    const deliveries = await prisma.automationDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return reply.send(deliveries);
  });
}

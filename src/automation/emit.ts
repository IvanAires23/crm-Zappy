import { prisma } from "../db/prisma.js";
import { automationQueue } from "../queue/queue.js";

// Chamado a partir das rotas (deal mudou de estágio, task venceu, etc.)
// sempre que algo relevante acontece. Não bloqueia a resposta HTTP — só
// enfileira a entrega pra cada webhook de automação inscrito no evento.
export async function emitAutomationEvent(
  tenantId: string,
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  const webhooks = await prisma.automationWebhook.findMany({
    where: { tenantId, isActive: true },
  });

  const matching = webhooks.filter((w) => w.events.length === 0 || w.events.includes(event));

  for (const webhook of matching) {
    const job = await automationQueue.add("dispatch", { webhookId: webhook.id, event, data });

    await prisma.automationDelivery.create({
      data: {
        webhookId: webhook.id,
        jobId: job.id!,
        event,
        payload: data as any,
      },
    });
  }
}

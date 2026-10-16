import { prisma } from "../db/prisma.js";
import { automationQueue } from "../queue/queue.js";
import { matchesConditions } from "./actions.js";
import { enrollInWorkflows } from "./workflow.js";

// Chamado a partir das rotas (deal mudou de estágio, task venceu, etc.)
// sempre que algo relevante acontece. Não bloqueia a resposta HTTP — só
// enfileira: (1) a entrega pra cada webhook de automação inscrito no
// evento, (2) a execução de cada regra interna cujo gatilho e condições
// batem com esse evento e (3) a inscrição em cada fluxo do construtor
// visual com um gatilho que bate.
export async function emitAutomationEvent(
  tenantId: string,
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  const webhooks = await prisma.automationWebhook.findMany({
    where: { tenantId, isActive: true },
  });

  const matchingWebhooks = webhooks.filter((w) => w.events.length === 0 || w.events.includes(event));

  for (const webhook of matchingWebhooks) {
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

  const rules = await prisma.automationRule.findMany({
    where: { tenantId, isActive: true, triggerEvent: event },
  });

  const matchingRules = rules.filter((r) => matchesConditions(data, r.triggerConditions));

  for (const rule of matchingRules) {
    const job = await automationQueue.add("execute-rule", { ruleId: rule.id, tenantId, event, data });

    await prisma.automationRuleRun.create({
      data: {
        ruleId: rule.id,
        jobId: job.id!,
        event,
        triggerData: data as any,
      },
    });
  }

  await enrollInWorkflows(tenantId, event, data);
}

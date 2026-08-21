import { prisma } from "../db/prisma.js";

export type RuleAction =
  | { type: "update_deal_status"; status: "open" | "won" | "lost"; lostReason?: string }
  | { type: "move_deal_stage"; stageId: string }
  | {
      type: "create_task";
      title: string;
      description?: string;
      dueInMinutes?: number;
      priority?: "low" | "medium" | "high";
      assignedUserId?: string;
    }
  | { type: "create_deal"; stageId: string; title?: string };

// Todos os pares de `conditions` precisam bater com `data` (AND simples,
// comparação exata). `conditions` vazio/ausente = sempre bate.
export function matchesConditions(data: Record<string, unknown>, conditions: unknown): boolean {
  if (!conditions || typeof conditions !== "object") return true;

  return Object.entries(conditions as Record<string, unknown>).every(([key, expected]) => data[key] === expected);
}

// Executa uma ação de automação. Lança erro (não captura) de propósito —
// quem chama decide o que fazer com a falha (registrar no AutomationRuleRun,
// deixar o BullMQ tentar de novo).
export async function executeAction(
  tenantId: string,
  action: RuleAction,
  eventData: Record<string, unknown>
): Promise<void> {
  switch (action.type) {
    case "update_deal_status": {
      const dealId = eventData.dealId as string | undefined;
      if (!dealId) throw new Error("Evento não tem dealId — ação update_deal_status não se aplica");

      const now = new Date();
      await prisma.deal.update({
        where: { id: dealId },
        data: {
          status: action.status,
          wonAt: action.status === "won" ? now : null,
          lostAt: action.status === "lost" ? now : null,
          lostReason: action.status === "lost" ? action.lostReason ?? null : null,
        },
      });
      return;
    }

    case "move_deal_stage": {
      const dealId = eventData.dealId as string | undefined;
      if (!dealId) throw new Error("Evento não tem dealId — ação move_deal_stage não se aplica");

      const stage = await prisma.pipelineStage.findFirst({
        where: { id: action.stageId, pipeline: { tenantId } },
      });
      if (!stage) throw new Error("Estágio de destino não encontrado (ou não pertence a esse tenant)");

      const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId } });
      if (!deal) throw new Error("Deal não encontrado");

      const lastInStage = await prisma.deal.findFirst({
        where: { stageId: stage.id },
        orderBy: { position: "desc" },
      });

      // O estágio de destino já diz a qual pipeline pertence — é assim
      // que "mover pra outra pipeline" funciona sem precisar de um
      // parâmetro separado.
      await prisma.$transaction([
        prisma.deal.update({
          where: { id: dealId },
          data: {
            pipelineId: stage.pipelineId,
            stageId: stage.id,
            position: (lastInStage?.position ?? -1) + 1,
          },
        }),
        prisma.dealStageHistory.create({
          data: { dealId, fromStageId: deal.stageId, toStageId: stage.id, movedByUserId: null },
        }),
      ]);
      return;
    }

    case "create_task": {
      await prisma.task.create({
        data: {
          tenantId,
          title: action.title,
          description: action.description,
          dueAt: new Date(Date.now() + (action.dueInMinutes ?? 24 * 60) * 60000),
          priority: action.priority ?? "medium",
          assignedUserId: action.assignedUserId,
          contactId: (eventData.contactId as string | undefined) ?? null,
          dealId: (eventData.dealId as string | undefined) ?? null,
        },
      });
      return;
    }

    case "create_deal": {
      const stage = await prisma.pipelineStage.findFirst({
        where: { id: action.stageId, pipeline: { tenantId } },
      });
      if (!stage) throw new Error("Estágio de destino não encontrado (ou não pertence a esse tenant)");

      const lastInStage = await prisma.deal.findFirst({
        where: { stageId: stage.id },
        orderBy: { position: "desc" },
      });

      await prisma.deal.create({
        data: {
          tenantId,
          pipelineId: stage.pipelineId,
          stageId: stage.id,
          title: action.title ?? "Novo lead automático",
          contactId: (eventData.contactId as string | undefined) ?? null,
          position: (lastInStage?.position ?? -1) + 1,
        },
      });
      return;
    }
  }
}

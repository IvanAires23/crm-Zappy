import { prisma } from "../db/prisma.js";
import { createTask } from "../tasks/taskService.js";

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
  | { type: "create_deal"; stageId: string; title?: string }
  | {
      type: "call_webhook";
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      headers?: Record<string, string>;
      body?: unknown;
    };

// Todos os pares de `conditions` precisam bater com `data` (AND simples,
// comparação exata). `conditions` vazio/ausente = sempre bate.
export function matchesConditions(data: Record<string, unknown>, conditions: unknown): boolean {
  if (!conditions || typeof conditions !== "object") return true;

  return Object.entries(conditions as Record<string, unknown>).every(([key, expected]) => data[key] === expected);
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// Substitui "{{campo}}" ou "{{contact.phone}}" (dot-path) pelos valores
// do evento que disparou a regra. Funciona em strings dentro de qualquer
// estrutura (objeto, array, ou string solta) — é assim que a URL/corpo
// de call_webhook conseguem referenciar dados do evento.
export function interpolate(template: unknown, data: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
      const value = getByPath(data, path);
      return value === undefined || value === null ? "" : String(value);
    });
  }
  if (Array.isArray(template)) return template.map((item) => interpolate(item, data));
  if (template && typeof template === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) result[key] = interpolate(value, data);
    return result;
  }
  return template;
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
      await createTask(tenantId, {
        title: action.title,
        description: action.description,
        dueAt: new Date(Date.now() + (action.dueInMinutes ?? 24 * 60) * 60000),
        priority: action.priority ?? "medium",
        assignedUserId: action.assignedUserId,
        contactId: (eventData.contactId as string | undefined) ?? null,
        dealId: (eventData.dealId as string | undefined) ?? null,
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

    case "call_webhook": {
      const url = interpolate(action.url, eventData) as string;
      const method = action.method ?? "POST";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...((action.headers ? (interpolate(action.headers, eventData) as Record<string, string>) : {}) ?? {}),
      };
      const body = action.body !== undefined ? JSON.stringify(interpolate(action.body, eventData)) : undefined;

      const res = await fetch(url, {
        method,
        headers,
        ...(method !== "GET" && body !== undefined ? { body } : {}),
      });

      if (!res.ok) {
        throw new Error(`call_webhook: ${url} respondeu ${res.status}`);
      }
      return;
    }
  }
}

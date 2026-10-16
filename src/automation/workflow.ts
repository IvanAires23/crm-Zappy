import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { automationQueue, outboundQueue } from "../queue/queue.js";
import { publishRealtimeEvent } from "../realtime/bus.js";
import { resolveTagId } from "../tags/findOrCreateTag.js";
import { getTenantProvider } from "../whatsapp/client.js";
import { isMessagingRestricted } from "../whatsapp/window.js";
import { executeAction, interpolate, type RuleAction } from "./actions.js";

// ------------------------------------------------------------------
// Tipos do grafo salvo em AutomationWorkflow.graph / .triggers
// ------------------------------------------------------------------

export type FilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "includes"
  | "not_includes"
  | "exists"
  | "not_exists";

export interface WorkflowFilter {
  field: string; // dot-path no contexto, ex: "contact.tags", "message.text"
  operator: FilterOperator;
  value?: string;
}

export interface WorkflowTrigger {
  id: string;
  event: string;
  filters: WorkflowFilter[];
}

export type WorkflowAction =
  | RuleAction
  | { type: "add_contact_tag"; tagName: string }
  | { type: "remove_contact_tag"; tagName: string }
  | { type: "send_whatsapp_message"; text: string };

export interface ConditionBranch {
  id: string;
  label: string;
  match: "all" | "any";
  filters: WorkflowFilter[];
  next: string | null;
}

// Grafo é uma árvore (ramos nunca se juntam de novo): cada nó aponta pro
// próximo por id, o que permite retomar uma execução só guardando o id
// do nó onde ela parou (AutomationWorkflowRun.currentNodeId).
export type WorkflowNode =
  | { id: string; type: "action"; action: WorkflowAction; next: string | null }
  | { id: string; type: "wait"; minutes: number; next: string | null }
  | { id: string; type: "condition"; branches: ConditionBranch[]; elseNext: string | null };

export interface WorkflowGraph {
  startNodeId: string | null;
  nodes: Record<string, WorkflowNode>;
}

export interface RunStep {
  nodeId: string | null;
  type: "trigger" | "action" | "wait" | "condition" | "end";
  status: "success" | "failed" | "info";
  at: string;
  detail?: string;
}

// ------------------------------------------------------------------
// Contexto: o que filtros e condições enxergam. Montado de novo a cada
// passo, pra que uma tag adicionada num passo anterior já valha numa
// condição depois de uma espera.
// ------------------------------------------------------------------

export interface WorkflowContext {
  event: string;
  trigger: Record<string, unknown>;
  contact: { id: string; name: string | null; phone: string; tags: string[] } | null;
  deal: {
    id: string;
    title: string;
    status: string;
    stageId: string;
    stageName: string;
    pipelineId: string;
  } | null;
  message: { text: string; channel: string } | null;
}

function contactIdFrom(data: Record<string, unknown>): string | null {
  if (typeof data.contactId === "string") return data.contactId;
  const contact = data.contact as { id?: unknown } | null | undefined;
  return contact && typeof contact.id === "string" ? contact.id : null;
}

export async function buildContext(
  tenantId: string,
  event: string,
  data: Record<string, unknown>,
  dealIdHint?: string | null
): Promise<WorkflowContext> {
  const explicitDealId = (typeof data.dealId === "string" ? data.dealId : null) ?? dealIdHint ?? null;
  let contactId = contactIdFrom(data);

  const explicitDeal = explicitDealId
    ? await prisma.deal.findFirst({ where: { id: explicitDealId, tenantId }, include: { stage: true } })
    : null;
  if (!contactId && explicitDeal?.contactId) contactId = explicitDeal.contactId;

  const contact = contactId
    ? await prisma.contact.findFirst({
        where: { id: contactId, tenantId },
        include: { tags: { include: { tag: true } } },
      })
    : null;

  // Sem deal no evento (ex: "cliente respondeu"), usa o negócio aberto
  // mais recente do contato — é o que "procura oportunidade" significa.
  const deal =
    explicitDeal ??
    (contact
      ? await prisma.deal.findFirst({
          where: { tenantId, contactId: contact.id, status: "open" },
          orderBy: { createdAt: "desc" },
          include: { stage: true },
        })
      : null);

  const text = typeof data.text === "string" ? data.text : null;

  return {
    event,
    trigger: data,
    contact: contact
      ? { id: contact.id, name: contact.name, phone: contact.phone, tags: contact.tags.map((t) => t.tag.name) }
      : null,
    deal: deal
      ? {
          id: deal.id,
          title: deal.title,
          status: deal.status,
          stageId: deal.stageId,
          stageName: deal.stage.name,
          pipelineId: deal.pipelineId,
        }
      : null,
    message: text !== null ? { text, channel: typeof data.channel === "string" ? data.channel : "whatsapp" } : null,
  };
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function evaluateFilter(filter: WorkflowFilter, ctx: WorkflowContext): boolean {
  const actual = getByPath(ctx, filter.field);
  const expected = norm(filter.value);

  switch (filter.operator) {
    case "exists":
      return Array.isArray(actual) ? actual.length > 0 : actual !== undefined && actual !== null && actual !== "";
    case "not_exists":
      return !evaluateFilter({ ...filter, operator: "exists" }, ctx);
    case "includes":
      return Array.isArray(actual) && actual.some((item) => norm(item) === expected);
    case "not_includes":
      return !(Array.isArray(actual) && actual.some((item) => norm(item) === expected));
    case "equals":
      return norm(actual) === expected;
    case "not_equals":
      return norm(actual) !== expected;
    case "contains":
      return norm(actual).includes(expected);
    case "not_contains":
      return !norm(actual).includes(expected);
  }
}

export function matchesFilters(filters: WorkflowFilter[], ctx: WorkflowContext, match: "all" | "any" = "all"): boolean {
  if (filters.length === 0) return true;
  return match === "all" ? filters.every((f) => evaluateFilter(f, ctx)) : filters.some((f) => evaluateFilter(f, ctx));
}

// ------------------------------------------------------------------
// Ações próprias do fluxo (as demais reaproveitam executeAction das regras)
// ------------------------------------------------------------------

async function sendWhatsappMessage(tenantId: string, ctx: WorkflowContext, rawText: string) {
  if (!ctx.contact) throw new Error("Execução sem contato — não há para quem enviar a mensagem");
  const text = String(interpolate(rawText, ctx as unknown as Record<string, unknown>)).trim();
  if (!text) throw new Error("Mensagem vazia depois de substituir as variáveis");

  const conversation =
    (await prisma.conversation.findFirst({
      where: { tenantId, contactId: ctx.contact.id, status: { not: "closed" } },
      orderBy: { lastMessageAt: "desc" },
    })) ??
    (await prisma.conversation.create({ data: { tenantId, contactId: ctx.contact.id, status: "open" } }));

  const provider = await getTenantProvider(tenantId);
  if (isMessagingRestricted(provider, conversation.lastInboundMessageAt)) {
    throw new Error("Fora da janela de 24h da Meta — texto livre seria recusado (use um template)");
  }

  const now = new Date();
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        direction: "outbound",
        type: "text",
        content: { text },
        status: "pending",
        source: "automation",
      },
    });
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now } });
    return created;
  });

  await outboundQueue.add("send-message", { tenantId, messageId: message.id, to: ctx.contact.phone, text });
  await publishRealtimeEvent({ tenantId, event: "message:new", data: { conversationId: conversation.id, message } });
}

const LEGACY_ACTION_DETAILS: Record<RuleAction["type"], string> = {
  create_deal: "Oportunidade criada",
  move_deal_stage: "Oportunidade movida de estágio",
  update_deal_status: "Status da oportunidade atualizado",
  create_task: "Tarefa criada",
  call_webhook: "Webhook chamado",
};

// Tag aplicada por fluxo não emite "contact.tag_added" de propósito: um
// fluxo disparado por tag que adiciona tag viraria um loop de execuções.
async function executeWorkflowAction(tenantId: string, action: WorkflowAction, ctx: WorkflowContext): Promise<string> {
  switch (action.type) {
    case "add_contact_tag": {
      if (!ctx.contact) throw new Error("Execução sem contato — não dá pra adicionar etiqueta");
      const resolved = await resolveTagId(tenantId, { name: action.tagName });
      if ("error" in resolved) throw new Error(resolved.error);
      await prisma.contactTag.upsert({
        where: { contactId_tagId: { contactId: ctx.contact.id, tagId: resolved.id } },
        create: { contactId: ctx.contact.id, tagId: resolved.id },
        update: {},
      });
      return `Etiqueta "${action.tagName}" adicionada`;
    }
    case "remove_contact_tag": {
      if (!ctx.contact) throw new Error("Execução sem contato — não dá pra remover etiqueta");
      const resolved = await resolveTagId(tenantId, { name: action.tagName });
      if ("error" in resolved) throw new Error(resolved.error);
      await prisma.contactTag.deleteMany({ where: { contactId: ctx.contact.id, tagId: resolved.id } });
      return `Etiqueta "${action.tagName}" removida`;
    }
    case "send_whatsapp_message":
      await sendWhatsappMessage(tenantId, ctx, action.text);
      return "Mensagem enviada";
    default: {
      // Ações herdadas das regras esperam dealId/contactId soltos no evento —
      // aqui vêm do contexto (inclui o negócio encontrado pro contato).
      const data = {
        ...ctx.trigger,
        ...ctx,
        dealId: ctx.deal?.id,
        contactId: ctx.contact?.id,
      } as Record<string, unknown>;
      await executeAction(tenantId, action, data);
      return LEGACY_ACTION_DETAILS[action.type];
    }
  }
}

// ------------------------------------------------------------------
// Motor
// ------------------------------------------------------------------

const MAX_STEPS_PER_ADVANCE = 200;

export async function enqueueWorkflowStep(runId: string, nodeId: string | null, delayMs = 0) {
  // attempts: 1 — repetir um passo poderia mandar mensagem/criar negócio
  // duas vezes; a falha fica registrada no log da execução.
  await automationQueue.add("workflow-step", { runId, nodeId }, { attempts: 1, delay: delayMs });
}

function step(nodeId: string | null, type: RunStep["type"], status: RunStep["status"], detail?: string): RunStep {
  return { nodeId, type, status, at: new Date().toISOString(), detail };
}

export async function advanceRun(runId: string, startNodeId: string | null): Promise<void> {
  const run = await prisma.automationWorkflowRun.findUnique({ where: { id: runId }, include: { workflow: true } });
  if (!run || run.status === "completed" || run.status === "failed") return;

  const steps = [...((run.steps as unknown as RunStep[]) ?? [])];
  const save = (data: Prisma.AutomationWorkflowRunUpdateInput) =>
    prisma.automationWorkflowRun.update({
      where: { id: run.id },
      data: { ...data, steps: steps as unknown as Prisma.InputJsonValue },
    });

  if (!run.workflow.isActive) {
    steps.push(step(startNodeId, "end", "info", "Fluxo desativado — execução encerrada"));
    await save({ status: "completed", currentNodeId: null, resumeAt: null });
    return;
  }

  const graph = run.workflow.graph as unknown as WorkflowGraph;
  const triggerData = run.triggerData as Record<string, unknown>;
  let current = startNodeId;

  for (let i = 0; current && i < MAX_STEPS_PER_ADVANCE; i++) {
    const node: WorkflowNode | undefined = graph.nodes?.[current];
    if (!node) {
      steps.push(step(current, "end", "failed", "Este passo foi removido do fluxo"));
      await save({ status: "failed", currentNodeId: null, error: "Passo removido do fluxo" });
      return;
    }

    const ctx = await buildContext(run.tenantId, run.triggerEvent, triggerData, run.dealId);

    if (node.type === "wait") {
      if (!node.next) {
        current = null;
        break;
      }
      const delayMs = Math.max(0, node.minutes) * 60_000;
      steps.push(step(node.id, "wait", "info", `Aguardando ${node.minutes} min`));
      await save({ status: "waiting", currentNodeId: node.next, resumeAt: new Date(Date.now() + delayMs) });
      await enqueueWorkflowStep(run.id, node.next, delayMs);
      return;
    }

    if (node.type === "condition") {
      const branch = node.branches.find((b) => matchesFilters(b.filters, ctx, b.match));
      steps.push(step(node.id, "condition", "success", branch ? `Caminho: ${branch.label}` : "Caminho: Nenhuma"));
      current = branch ? branch.next : node.elseNext;
      continue;
    }

    try {
      const detail = await executeWorkflowAction(run.tenantId, node.action, ctx);
      steps.push(step(node.id, "action", "success", detail));
      await save({ status: "running", currentNodeId: node.next });
    } catch (err) {
      const message = (err as Error).message;
      steps.push(step(node.id, "action", "failed", message));
      await save({ status: "failed", currentNodeId: null, error: message });
      return;
    }
    current = node.next;
  }

  steps.push(step(null, "end", "success", "Fim do fluxo"));
  await save({ status: "completed", currentNodeId: null, resumeAt: null });
}

// Chamado por emitAutomationEvent: inscreve o evento em todo fluxo ativo
// com um gatilho que bate (evento + filtros).
export async function enrollInWorkflows(tenantId: string, event: string, data: Record<string, unknown>) {
  const workflows = await prisma.automationWorkflow.findMany({ where: { tenantId, isActive: true } });
  const candidates = workflows.filter((w) =>
    ((w.triggers as unknown as WorkflowTrigger[]) ?? []).some((t) => t.event === event)
  );
  if (candidates.length === 0) return;

  const ctx = await buildContext(tenantId, event, data);

  for (const workflow of candidates) {
    const triggers = (workflow.triggers as unknown as WorkflowTrigger[]).filter((t) => t.event === event);
    if (!triggers.some((t) => matchesFilters(t.filters ?? [], ctx))) continue;

    if (!workflow.allowReentry && ctx.contact) {
      const active = await prisma.automationWorkflowRun.findFirst({
        where: { workflowId: workflow.id, contactId: ctx.contact.id, status: { in: ["running", "waiting"] } },
        select: { id: true },
      });
      if (active) continue;
    }

    const graph = workflow.graph as unknown as WorkflowGraph;
    const run = await prisma.automationWorkflowRun.create({
      data: {
        workflowId: workflow.id,
        tenantId,
        contactId: ctx.contact?.id ?? null,
        dealId: typeof data.dealId === "string" ? data.dealId : null,
        triggerEvent: event,
        triggerData: data as Prisma.InputJsonValue,
        status: "running",
        currentNodeId: graph.startNodeId ?? null,
        steps: [step(null, "trigger", "success", event)] as unknown as Prisma.InputJsonValue,
      },
    });

    await enqueueWorkflowStep(run.id, graph.startNodeId ?? null);
  }
}

import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { automationQueue, outboundQueue } from "../queue/queue.js";
import { publishRealtimeEvent } from "../realtime/bus.js";
import { resolveTagId } from "../tags/findOrCreateTag.js";
import { getTenantProvider, numberedMenuText } from "../whatsapp/client.js";
import { isMessagingRestricted } from "../whatsapp/window.js";
import { sendTemplateToConversation } from "../templates/templateService.js";
import { executeAction, interpolate, type RuleAction } from "./actions.js";
import { buildContext, type WorkflowContext } from "./context.js";

export { buildContext, type WorkflowContext } from "./context.js";

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
  | "not_exists"
  | "greater_than"
  | "less_than";

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

export type AssignTarget = "deal" | "conversation" | "both";

export type WorkflowAction =
  | RuleAction
  | { type: "add_contact_tag"; tagName: string }
  | { type: "remove_contact_tag"; tagName: string }
  | { type: "add_deal_tag"; tagName: string }
  | { type: "remove_deal_tag"; tagName: string }
  | { type: "send_whatsapp_message"; text: string }
  | { type: "send_template"; templateId: string }
  // Kommo: "Mudar responsável" + "Distribuição de leads". balanced = quem
  // tem menos itens abertos entre os escolhidos.
  | { type: "assign_user"; target: AssignTarget; mode: "fixed" | "balanced"; userIds: string[] }
  // Campo fixo (title, valueCents) ou id de campo personalizado. O valor
  // aceita marcadores — {{message.text}} grava a resposta do cliente.
  | { type: "update_deal_field"; field: string; value: string }
  | { type: "update_contact"; name: string }
  | { type: "add_note"; text: string }
  | { type: "close_conversation" };

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
  | {
      id: string;
      type: "wait";
      minutes: number;
      // time_of_day = espera até o próximo HH:MM (horário de Brasília),
      // opcionalmente pulando sábado/domingo — "mandar só em horário comercial".
      mode?: "duration" | "time_of_day";
      time?: string;
      weekdaysOnly?: boolean;
      next: string | null;
    }
  | { id: string; type: "condition"; branches: ConditionBranch[]; elseNext: string | null }
  // Salesbot "esperar resposta": pausa até o cliente mandar mensagem
  // (segue por next, com {{message.text}} = resposta) ou o tempo acabar
  // (segue por timeoutNext).
  | { id: string; type: "wait_reply"; timeoutMinutes: number; next: string | null; timeoutNext: string | null }
  // Salesbot "pergunta com botões": manda a mensagem com botões e espera
  // o clique. Cada botão é um caminho; resposta digitada que não bate com
  // nenhum vai por otherNext; prazo esgotado, por timeoutNext.
  | {
      id: string;
      type: "ask_buttons";
      text: string;
      buttons: ReplyButtonOption[];
      timeoutMinutes: number;
      otherNext: string | null;
      timeoutNext: string | null;
    };

export interface ReplyButtonOption {
  id: string;
  label: string;
  next: string | null;
}

export interface WorkflowGraph {
  startNodeId: string | null;
  nodes: Record<string, WorkflowNode>;
}

export interface RunStep {
  nodeId: string | null;
  type: "trigger" | "action" | "wait" | "condition" | "wait_reply" | "ask_buttons" | "end";
  status: "success" | "failed" | "info";
  at: string;
  detail?: string;
}

export function nodeTargets(node: WorkflowNode): (string | null)[] {
  if (node.type === "condition") return [...node.branches.map((b) => b.next), node.elseNext];
  if (node.type === "wait_reply") return [node.next, node.timeoutNext];
  if (node.type === "ask_buttons") return [...node.buttons.map((b) => b.next), node.otherNext, node.timeoutNext];
  return [node.next];
}

// ------------------------------------------------------------------
// Filtros
// ------------------------------------------------------------------

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
}

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
      // Várias palavras separadas por vírgula = qualquer uma (palavras-chave
      // de resposta, igual às condições do Salesbot).
      return expected.split(",").map((s) => s.trim()).filter(Boolean).some((word) => norm(actual).includes(word));
    case "not_contains":
      return !expected.split(",").map((s) => s.trim()).filter(Boolean).some((word) => norm(actual).includes(word));
    case "greater_than":
    case "less_than": {
      // deal.valueCents é comparado em reais — é o que o usuário digita.
      const raw = filter.field === "deal.valueCents" && typeof actual === "number" ? actual / 100 : actual;
      const a = toNumber(raw);
      const b = toNumber(filter.value);
      if (a === null || b === null) return false;
      return filter.operator === "greater_than" ? a > b : a < b;
    }
  }
}

export function matchesFilters(filters: WorkflowFilter[], ctx: WorkflowContext, match: "all" | "any" = "all"): boolean {
  if (filters.length === 0) return true;
  return match === "all" ? filters.every((f) => evaluateFilter(f, ctx)) : filters.some((f) => evaluateFilter(f, ctx));
}

// ------------------------------------------------------------------
// Ações próprias do fluxo (as demais reaproveitam executeAction das regras)
// ------------------------------------------------------------------

const render = (text: string, ctx: WorkflowContext) =>
  String(interpolate(text, ctx as unknown as Record<string, unknown>)).trim();

async function contactConversation(tenantId: string, ctx: WorkflowContext) {
  if (!ctx.contact) throw new Error("Execução sem contato — não há para quem enviar a mensagem");
  return (
    (await prisma.conversation.findFirst({
      where: { tenantId, contactId: ctx.contact.id, status: { not: "closed" } },
      orderBy: { lastMessageAt: "desc" },
    })) ?? (await prisma.conversation.create({ data: { tenantId, contactId: ctx.contact.id, status: "open" } }))
  );
}

async function sendWhatsappMessage(
  tenantId: string,
  ctx: WorkflowContext,
  rawText: string,
  buttons?: { id: string; title: string }[]
) {
  const text = render(rawText, ctx);
  if (!text) throw new Error("Mensagem vazia depois de substituir as variáveis");

  const conversation = await contactConversation(tenantId, ctx);
  const provider = await getTenantProvider(tenantId);
  if (isMessagingRestricted(provider, conversation.lastInboundMessageAt)) {
    throw new Error("Fora da janela de 24h da Meta — texto livre seria recusado (use a ação Enviar template)");
  }

  const now = new Date();
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        direction: "outbound",
        type: buttons ? "interactive" : "text",
        // Histórico guarda o menu numerado: é o que o cliente vê na API não
        // oficial, e na oficial deixa claro quais opções foram oferecidas.
        content: buttons ? { text: numberedMenuText(text, buttons), buttons: buttons.map((b) => b.title) } : { text },
        status: "pending",
        source: "automation",
      },
    });
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now } });
    return created;
  });

  await outboundQueue.add("send-message", { tenantId, messageId: message.id, to: ctx.contact!.phone, text, buttons });
  await publishRealtimeEvent({ tenantId, event: "message:new", data: { conversationId: conversation.id, message } });
}

// Entre os usuários ativos escolhidos, quem tem menos itens abertos do
// tipo que está sendo distribuído.
async function pickBalancedUser(tenantId: string, userIds: string[], target: AssignTarget): Promise<string> {
  const users = await prisma.user.findMany({ where: { tenantId, id: { in: userIds }, active: true }, select: { id: true } });
  if (users.length === 0) throw new Error("Nenhum dos usuários escolhidos está ativo nesta conta");
  const loads = await Promise.all(
    users.map(async (u) => {
      const [deals, conversations] = await Promise.all([
        target === "conversation" ? 0 : prisma.deal.count({ where: { tenantId, assignedUserId: u.id, status: "open" } }),
        target === "deal" ? 0 : prisma.conversation.count({ where: { tenantId, assignedUserId: u.id, status: { not: "closed" } } }),
      ]);
      return { id: u.id, load: deals + conversations };
    })
  );
  // Ordem dos ids escolhidos desempata — previsível pra quem configura.
  loads.sort((a, b) => a.load - b.load || userIds.indexOf(a.id) - userIds.indexOf(b.id));
  return loads[0].id;
}

async function assignUser(tenantId: string, ctx: WorkflowContext, action: Extract<WorkflowAction, { type: "assign_user" }>) {
  if (action.userIds.length === 0) throw new Error("Escolha pelo menos um usuário");
  const userId =
    action.mode === "fixed" ? action.userIds[0] : await pickBalancedUser(tenantId, action.userIds, action.target);
  const user = await prisma.user.findFirst({ where: { id: userId, tenantId, active: true }, select: { id: true, name: true } });
  if (!user) throw new Error("Usuário escolhido não está ativo nesta conta");

  const done: string[] = [];
  if (action.target !== "conversation") {
    if (!ctx.deal) {
      if (action.target === "deal") throw new Error("Contato sem oportunidade aberta — não há o que atribuir");
    } else {
      await prisma.deal.update({ where: { id: ctx.deal.id }, data: { assignedUserId: user.id } });
      done.push("oportunidade");
    }
  }
  if (action.target !== "deal") {
    const conversation = ctx.conversation ? await prisma.conversation.findFirst({ where: { id: ctx.conversation.id, tenantId } }) : null;
    if (!conversation) {
      if (action.target === "conversation") throw new Error("Contato sem conversa — não há o que atribuir");
    } else {
      await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedUserId: user.id } });
      await publishRealtimeEvent({
        tenantId,
        event: "conversation:assigned",
        data: { conversationId: conversation.id, assignedUserId: user.id, assignedUser: user },
      });
      done.push("conversa");
    }
  }
  if (done.length === 0) throw new Error("Nada para atribuir (sem oportunidade nem conversa)");
  return `${done.join(" e ")} atribuída(s) a ${user.name}`;
}

async function updateDealField(tenantId: string, ctx: WorkflowContext, field: string, rawValue: string) {
  if (!ctx.deal) throw new Error("Contato sem oportunidade aberta — não há campo pra atualizar");
  const value = render(rawValue, ctx);

  if (field === "title") {
    if (!value) throw new Error("Título ficaria vazio");
    await prisma.deal.update({ where: { id: ctx.deal.id }, data: { title: value } });
    return `Título: "${value}"`;
  }
  if (field === "valueCents") {
    const n = toNumber(value);
    if (n === null) throw new Error(`"${value}" não é um valor numérico`);
    await prisma.deal.update({ where: { id: ctx.deal.id }, data: { valueCents: Math.round(n * 100) } });
    return `Valor: ${value}`;
  }

  const def = await prisma.dealCustomFieldDefinition.findFirst({ where: { id: field, tenantId } });
  if (!def) throw new Error("Campo personalizado não existe mais");
  const options = (def.options as string[]) ?? [];
  let stored: unknown = value || null;
  if (value && def.type === "number") {
    const n = toNumber(value);
    if (n === null) throw new Error(`"${value}" não é número (campo "${def.name}")`);
    stored = n;
  } else if (value && def.type === "select") {
    const opt = options.find((o) => norm(o) === norm(value));
    if (!opt) throw new Error(`"${value}" não é uma opção do campo "${def.name}"`);
    stored = opt;
  } else if (value && def.type === "multi_select") {
    const picked = value.split(",").map((v) => options.find((o) => norm(o) === norm(v)));
    if (picked.some((p) => !p)) throw new Error(`Algum valor não é opção do campo "${def.name}"`);
    stored = picked;
  }

  const deal = await prisma.deal.findUnique({ where: { id: ctx.deal.id }, select: { customFields: true } });
  const customFields = { ...((deal?.customFields ?? {}) as Record<string, unknown>), [def.id]: stored };
  await prisma.deal.update({ where: { id: ctx.deal.id }, data: { customFields: customFields as Prisma.InputJsonValue } });
  return `${def.name}: ${value || "(vazio)"}`;
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
// Pelo mesmo motivo nenhuma ação aqui emite evento de automação.
async function executeWorkflowAction(tenantId: string, action: WorkflowAction, ctx: WorkflowContext): Promise<string> {
  switch (action.type) {
    case "add_contact_tag":
    case "remove_contact_tag": {
      if (!ctx.contact) throw new Error("Execução sem contato — não dá pra mudar etiqueta");
      const tagName = render(action.tagName, ctx);
      const resolved = await resolveTagId(tenantId, { name: tagName });
      if ("error" in resolved) throw new Error(resolved.error);
      if (action.type === "add_contact_tag") {
        await prisma.contactTag.upsert({
          where: { contactId_tagId: { contactId: ctx.contact.id, tagId: resolved.id } },
          create: { contactId: ctx.contact.id, tagId: resolved.id },
          update: {},
        });
        return `Etiqueta "${tagName}" adicionada ao contato`;
      }
      await prisma.contactTag.deleteMany({ where: { contactId: ctx.contact.id, tagId: resolved.id } });
      return `Etiqueta "${tagName}" removida do contato`;
    }
    case "add_deal_tag":
    case "remove_deal_tag": {
      if (!ctx.deal) throw new Error("Contato sem oportunidade aberta — não dá pra mudar etiqueta da oportunidade");
      const tagName = render(action.tagName, ctx);
      const resolved = await resolveTagId(tenantId, { name: tagName });
      if ("error" in resolved) throw new Error(resolved.error);
      if (action.type === "add_deal_tag") {
        await prisma.dealTag.upsert({
          where: { dealId_tagId: { dealId: ctx.deal.id, tagId: resolved.id } },
          create: { dealId: ctx.deal.id, tagId: resolved.id },
          update: {},
        });
        return `Etiqueta "${tagName}" adicionada à oportunidade`;
      }
      await prisma.dealTag.deleteMany({ where: { dealId: ctx.deal.id, tagId: resolved.id } });
      return `Etiqueta "${tagName}" removida da oportunidade`;
    }
    case "send_whatsapp_message":
      await sendWhatsappMessage(tenantId, ctx, action.text);
      return "Mensagem enviada";
    case "send_template": {
      const template = await prisma.template.findFirst({ where: { id: action.templateId, tenantId } });
      if (!template) throw new Error("Modelo de mensagem não existe mais");
      const conversation = await contactConversation(tenantId, ctx);
      await sendTemplateToConversation({ tenantId, conversationId: conversation.id, template, ctx, source: "automation" });
      return `Modelo "${template.name}" enviado`;
    }
    case "assign_user":
      return assignUser(tenantId, ctx, action);
    case "update_deal_field":
      return updateDealField(tenantId, ctx, action.field, action.value);
    case "update_contact": {
      if (!ctx.contact) throw new Error("Execução sem contato");
      const name = render(action.name, ctx);
      if (!name) throw new Error("Nome ficaria vazio");
      await prisma.contact.update({ where: { id: ctx.contact.id }, data: { name: name.slice(0, 120) } });
      return `Nome do contato: "${name}"`;
    }
    case "add_note": {
      if (!ctx.contact) throw new Error("Execução sem contato — não dá pra criar nota");
      const content = render(action.text, ctx);
      if (!content) throw new Error("Nota ficaria vazia");
      await prisma.note.create({
        data: { tenantId, contactId: ctx.contact.id, conversationId: ctx.conversation?.id ?? null, content },
      });
      return "Nota criada";
    }
    case "close_conversation": {
      if (!ctx.conversation) throw new Error("Contato sem conversa");
      await prisma.conversation.update({ where: { id: ctx.conversation.id }, data: { status: "closed" } });
      await publishRealtimeEvent({
        tenantId,
        event: "conversation:status",
        data: { conversationId: ctx.conversation.id, status: "closed" },
      });
      return "Conversa encerrada";
    }
    default: {
      // Ações herdadas das regras esperam dealId/contactId soltos no evento —
      // aqui vêm do contexto (inclui o negócio encontrado pro contato).
      const data = {
        ...ctx.trigger,
        ...ctx,
        dealId: ctx.deal?.id,
        contactId: ctx.contact?.id,
      } as Record<string, unknown>;
      const rendered =
        action.type === "create_task"
          ? { ...action, title: render(action.title, ctx), description: action.description ? render(action.description, ctx) : undefined }
          : action.type === "create_deal" && action.title
            ? { ...action, title: render(action.title, ctx) }
            : action;
      await executeAction(tenantId, rendered, data);
      return LEGACY_ACTION_DETAILS[action.type];
    }
  }
}

// ------------------------------------------------------------------
// Espera até horário (Brasília, UTC-3 fixo desde o fim do horário de verão)
// ------------------------------------------------------------------

const BRT_OFFSET_MS = -3 * 60 * 60_000;

export function msUntilTimeOfDay(time: string, weekdaysOnly: boolean, now = new Date()): number {
  const [h, m] = time.split(":").map(Number);
  const local = new Date(now.getTime() + BRT_OFFSET_MS); // "relógio" de Brasília em campos UTC
  const target = new Date(local);
  target.setUTCHours(h || 0, m || 0, 0, 0);
  if (target.getTime() <= local.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  while (weekdaysOnly && (target.getUTCDay() === 0 || target.getUTCDay() === 6)) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - local.getTime();
}

function describeDelay(ms: number): string {
  const resumeAt = new Date(Date.now() + ms);
  return resumeAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
}

// ------------------------------------------------------------------
// Motor
// ------------------------------------------------------------------

const MAX_STEPS_PER_ADVANCE = 200;
const ACTIVE_RUN_STATUSES = ["running", "waiting", "waiting_reply"];

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
  if (!run || run.status === "completed" || run.status === "failed" || run.status === "waiting_reply") return;

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
      const delayMs =
        node.mode === "time_of_day" && node.time
          ? msUntilTimeOfDay(node.time, !!node.weekdaysOnly)
          : Math.max(0, node.minutes) * 60_000;
      steps.push(step(node.id, "wait", "info", `Aguardando até ${describeDelay(delayMs)}`));
      await save({ status: "waiting", currentNodeId: node.next, resumeAt: new Date(Date.now() + delayMs) });
      await enqueueWorkflowStep(run.id, node.next, delayMs);
      return;
    }

    if (node.type === "wait_reply") {
      if (!ctx.contact) {
        steps.push(step(node.id, "wait_reply", "failed", "Execução sem contato — não há resposta pra esperar"));
        await save({ status: "failed", currentNodeId: null, error: "Execução sem contato" });
        return;
      }
      const delayMs = Math.max(1, node.timeoutMinutes) * 60_000;
      steps.push(step(node.id, "wait_reply", "info", `Esperando resposta do cliente até ${describeDelay(delayMs)}`));
      // contactId gravado aqui é o que o message.received usa pra achar a
      // execução parada (o run pode ter nascido de um evento de deal).
      await save({
        status: "waiting_reply",
        currentNodeId: node.id,
        contactId: ctx.contact.id,
        resumeAt: new Date(Date.now() + delayMs),
      });
      await automationQueue.add("workflow-reply-timeout", { runId: run.id, nodeId: node.id }, { attempts: 1, delay: delayMs });
      return;
    }

    if (node.type === "ask_buttons") {
      try {
        await sendWhatsappMessage(
          run.tenantId,
          ctx,
          node.text,
          node.buttons.map((b) => ({ id: buttonReplyId(node.id, b.id), title: b.label }))
        );
      } catch (err) {
        const message = (err as Error).message;
        steps.push(step(node.id, "ask_buttons", "failed", message));
        await save({ status: "failed", currentNodeId: null, error: message });
        return;
      }
      const delayMs = Math.max(1, node.timeoutMinutes) * 60_000;
      steps.push(step(node.id, "ask_buttons", "info", `Pergunta enviada — esperando clique até ${describeDelay(delayMs)}`));
      await save({
        status: "waiting_reply",
        currentNodeId: node.id,
        contactId: ctx.contact!.id,
        resumeAt: new Date(Date.now() + delayMs),
      });
      await automationQueue.add("workflow-reply-timeout", { runId: run.id, nodeId: node.id }, { attempts: 1, delay: delayMs });
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

// Retoma uma execução parada em "Aguardar resposta". O updateMany com o
// status/nó atuais é a trava: se resposta e timeout chegarem juntos, só
// um dos dois "ganha" a execução.
async function resumeWaitingRun(
  runId: string,
  nodeId: string,
  outcome: "replied" | "timeout",
  reply?: Record<string, unknown>
): Promise<boolean> {
  const run = await prisma.automationWorkflowRun.findUnique({ where: { id: runId }, include: { workflow: true } });
  if (!run || run.status !== "waiting_reply" || run.currentNodeId !== nodeId) return false;
  const node = (run.workflow.graph as unknown as WorkflowGraph).nodes?.[nodeId];
  const waitingNode = node && (node.type === "wait_reply" || node.type === "ask_buttons") ? node : null;

  const steps = [...((run.steps as unknown as RunStep[]) ?? [])];
  const text = typeof reply?.text === "string" ? reply.text : "";
  let next: string | null = null;
  let detail = outcome === "replied" ? `Cliente respondeu: "${text.slice(0, 120)}"` : "Sem resposta no prazo";
  if (waitingNode?.type === "wait_reply") {
    next = outcome === "replied" ? waitingNode.next : waitingNode.timeoutNext;
  } else if (waitingNode?.type === "ask_buttons") {
    if (outcome === "timeout") {
      next = waitingNode.timeoutNext;
    } else {
      const clicked = matchButton(waitingNode, text, typeof reply?.buttonId === "string" ? reply.buttonId : null);
      next = clicked ? clicked.next : waitingNode.otherNext;
      detail = clicked ? `Cliente escolheu: "${clicked.label}"` : `Outra resposta: "${text.slice(0, 120)}"`;
    }
  }
  steps.push(step(nodeId, waitingNode?.type ?? "wait_reply", "success", detail));
  // A resposta vira o message.text do contexto daqui pra frente — é assim
  // que uma condição ou "Atualizar campo" usa o que o cliente escreveu.
  const triggerData = outcome === "replied" ? { ...(run.triggerData as Record<string, unknown>), ...reply } : undefined;

  const claimed = await prisma.automationWorkflowRun.updateMany({
    where: { id: runId, status: "waiting_reply", currentNodeId: nodeId },
    data: {
      status: "running",
      currentNodeId: next,
      resumeAt: null,
      steps: steps as unknown as Prisma.InputJsonValue,
      ...(triggerData ? { triggerData: triggerData as Prisma.InputJsonValue } : {}),
    },
  });
  if (claimed.count === 0) return false;

  if (!waitingNode) {
    await prisma.automationWorkflowRun.update({
      where: { id: runId },
      data: { status: "failed", error: "Passo removido do fluxo", currentNodeId: null },
    });
    return true;
  }
  await enqueueWorkflowStep(runId, next);
  return true;
}

// id que vai no botão da Cloud API e volta no clique — prefixado pelo nó
// pra um clique num botão de uma pergunta antiga não valer na atual.
function buttonReplyId(nodeId: string, buttonId: string) {
  return `${nodeId}:${buttonId}`;
}

const normalizeAnswer = (v: string) =>
  v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "");

// Clique (id do botão) ganha; senão aceita o texto do botão ou o número
// da opção ("1", "2"...) — é como o cliente responde no menu numerado da
// API não oficial, ou quando digita em vez de clicar.
export function matchButton(
  node: Extract<WorkflowNode, { type: "ask_buttons" }>,
  text: string,
  buttonId: string | null
): ReplyButtonOption | null {
  if (buttonId) {
    const byId = node.buttons.find((b) => buttonReplyId(node.id, b.id) === buttonId);
    if (byId) return byId;
  }
  const answer = normalizeAnswer(text);
  if (!answer) return null;
  const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
  if (index >= 0 && index < node.buttons.length) return node.buttons[index];
  return node.buttons.find((b) => normalizeAnswer(b.label) === answer) ?? null;
}

export async function handleReplyTimeout(runId: string, nodeId: string) {
  await resumeWaitingRun(runId, nodeId, "timeout");
}

// Mensagem do cliente: acorda as execuções desse contato que estavam em
// "Aguardar resposta". Retorna os fluxos acordados — eles não inscrevem
// o contato de novo por essa mesma mensagem.
async function resumeRunsWaitingReply(tenantId: string, data: Record<string, unknown>): Promise<Set<string>> {
  const resumed = new Set<string>();
  const contactId = typeof data.contactId === "string" ? data.contactId : null;
  if (!contactId) return resumed;
  const runs = await prisma.automationWorkflowRun.findMany({
    where: { tenantId, contactId, status: "waiting_reply" },
    select: { id: true, workflowId: true, currentNodeId: true },
  });
  for (const run of runs) {
    if (!run.currentNodeId) continue;
    const ok = await resumeWaitingRun(run.id, run.currentNodeId, "replied", {
      text: data.text ?? "",
      buttonId: data.buttonId ?? null,
      messageType: data.messageType ?? "text",
      channel: data.channel ?? "whatsapp",
      conversationId: data.conversationId,
    });
    if (ok) resumed.add(run.workflowId);
  }
  return resumed;
}

// Chamado por emitAutomationEvent: inscreve o evento em todo fluxo ativo
// com um gatilho que bate (evento + filtros).
export async function enrollInWorkflows(tenantId: string, event: string, data: Record<string, unknown>) {
  const resumedWorkflows = event === "message.received" ? await resumeRunsWaitingReply(tenantId, data) : new Set<string>();

  const workflows = await prisma.automationWorkflow.findMany({ where: { tenantId, isActive: true } });
  const candidates = workflows.filter(
    (w) => !resumedWorkflows.has(w.id) && ((w.triggers as unknown as WorkflowTrigger[]) ?? []).some((t) => t.event === event)
  );
  if (candidates.length === 0) return;

  const ctx = await buildContext(tenantId, event, data);

  for (const workflow of candidates) {
    const triggers = (workflow.triggers as unknown as WorkflowTrigger[]).filter((t) => t.event === event);
    if (!triggers.some((t) => matchesFilters(t.filters ?? [], ctx))) continue;

    if (!workflow.allowReentry && ctx.contact) {
      const active = await prisma.automationWorkflowRun.findFirst({
        where: { workflowId: workflow.id, contactId: ctx.contact.id, status: { in: ACTIVE_RUN_STATUSES } },
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

// Para todas as execuções em andamento de um fluxo (botão "Parar
// execuções" — útil depois de desativar um fluxo com muita gente esperando).
export async function stopActiveRuns(workflowId: string): Promise<number> {
  const result = await prisma.automationWorkflowRun.updateMany({
    where: { workflowId, status: { in: ACTIVE_RUN_STATUSES } },
    data: { status: "completed", currentNodeId: null, resumeAt: null, error: "Interrompida manualmente" },
  });
  return result.count;
}

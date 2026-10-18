import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { authenticate, requirePermission } from "../auth/auth.plugin.js";
import { actionSchema } from "./rules.routes.js";
import type { WorkflowGraph } from "./workflow.js";

const filterSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["equals", "not_equals", "contains", "not_contains", "includes", "not_includes", "exists", "not_exists"]),
  value: z.string().optional(),
});

const triggerSchema = z.object({
  id: z.string().min(1),
  event: z.string().min(1),
  filters: z.array(filterSchema).default([]),
});

const workflowActionSchema = z.union([
  actionSchema,
  z.object({ type: z.literal("add_contact_tag"), tagName: z.string().trim().min(1, "Informe a etiqueta") }),
  z.object({ type: z.literal("remove_contact_tag"), tagName: z.string().trim().min(1, "Informe a etiqueta") }),
  z.object({ type: z.literal("send_whatsapp_message"), text: z.string().trim().min(1, "Informe a mensagem") }),
]);

const nodeSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("action"), action: workflowActionSchema, next: z.string().nullable() }),
  z.object({
    id: z.string().min(1),
    type: z.literal("wait"),
    minutes: z.number().int().min(1, "A espera precisa ser de pelo menos 1 minuto").max(60 * 24 * 90),
    next: z.string().nullable(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("condition"),
    branches: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().trim().min(1),
          match: z.enum(["all", "any"]),
          filters: z.array(filterSchema).min(1, "Cada caminho da condição precisa de pelo menos uma regra"),
          next: z.string().nullable(),
        })
      )
      .min(1),
    elseNext: z.string().nullable(),
  }),
]);

const graphSchema = z.object({
  startNodeId: z.string().nullable(),
  nodes: z.record(z.string(), nodeSchema),
});

const createSchema = z.object({
  name: z.string().trim().min(1, "Informe um nome"),
});

const updateSchema = z.object({
  name: z.string().trim().min(1, "Informe um nome").optional(),
  isActive: z.boolean().optional(),
  allowReentry: z.boolean().optional(),
  triggers: z.array(triggerSchema).optional(),
  graph: graphSchema.optional(),
});

function firstZodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Dados inválidos";
  const where = issue.path.length ? ` (${issue.path.join(".")})` : "";
  return `${issue.message}${where}`;
}

// Árvore válida: todo "next" aponta pra um nó que existe, cada nó tem um
// único pai e todos são alcançáveis a partir do início — sem isso, uma
// execução poderia entrar em loop ou parar num passo que não existe.
function validateGraph(graph: WorkflowGraph): string | null {
  const ids = Object.keys(graph.nodes);
  for (const [key, node] of Object.entries(graph.nodes)) {
    if (node.id !== key) return "Passo com id inconsistente";
  }
  if (ids.length === 0) return graph.startNodeId ? "Passo inicial não existe" : null;
  if (!graph.startNodeId || !graph.nodes[graph.startNodeId]) return "Passo inicial não existe";

  const parents = new Map<string, number>();
  const link = (target: string | null) => {
    if (!target) return true;
    if (!graph.nodes[target]) return false;
    parents.set(target, (parents.get(target) ?? 0) + 1);
    return true;
  };

  for (const node of Object.values(graph.nodes)) {
    const targets = node.type === "condition" ? [...node.branches.map((b) => b.next), node.elseNext] : [node.next];
    if (!targets.every(link)) return "Um passo aponta pra outro que não existe";
  }
  if (parents.has(graph.startNodeId)) return "O passo inicial não pode ter um passo antes dele";
  if ([...parents.values()].some((count) => count > 1)) return "Cada passo só pode vir depois de um único passo";

  const seen = new Set<string>();
  const stack = [graph.startNodeId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) return "O fluxo tem um ciclo";
    seen.add(id);
    const node = graph.nodes[id];
    const targets = node.type === "condition" ? [...node.branches.map((b) => b.next), node.elseNext] : [node.next];
    for (const t of targets) if (t) stack.push(t);
  }
  if (seen.size !== ids.length) return "Há passos soltos, sem ligação com o início do fluxo";
  return null;
}

export async function automationWorkflowsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/automation/workflows", { preHandler: requirePermission("automations.view") }, async (request, reply) => {
    const tenantId = request.auth.tenantId;
    const workflows = await prisma.automationWorkflow.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });

    const counts = await prisma.automationWorkflowRun.groupBy({
      by: ["workflowId"],
      where: { tenantId },
      _count: { _all: true },
    });
    const countByWorkflow = new Map(counts.map((c) => [c.workflowId, c._count._all]));

    return reply.send(workflows.map((w) => ({ ...w, runCount: countByWorkflow.get(w.id) ?? 0 })));
  });

  app.post("/automation/workflows", { preHandler: requirePermission("automations.manage") }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: firstZodMessage(parsed.error) });

    const workflow = await prisma.automationWorkflow.create({
      data: {
        tenantId: request.auth.tenantId,
        name: parsed.data.name,
        triggers: [],
        graph: { startNodeId: null, nodes: {} },
      },
    });
    return reply.status(201).send(workflow);
  });

  app.get("/automation/workflows/:id", { preHandler: requirePermission("automations.view") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workflow = await prisma.automationWorkflow.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!workflow) return reply.status(404).send({ error: "Automação não encontrada" });
    return reply.send(workflow);
  });

  app.patch("/automation/workflows/:id", { preHandler: requirePermission("automations.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: firstZodMessage(parsed.error) });

    const existing = await prisma.automationWorkflow.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Automação não encontrada" });

    if (parsed.data.graph) {
      const problem = validateGraph(parsed.data.graph as WorkflowGraph);
      if (problem) return reply.status(400).send({ error: problem });
    }

    const triggers = parsed.data.triggers ?? (existing.triggers as unknown as unknown[]);
    if (parsed.data.isActive && triggers.length === 0) {
      return reply.status(400).send({ error: "Adicione pelo menos um acionador antes de ativar a automação" });
    }

    const workflow = await prisma.automationWorkflow.update({
      where: { id },
      data: {
        name: parsed.data.name,
        isActive: parsed.data.isActive,
        allowReentry: parsed.data.allowReentry,
        triggers: parsed.data.triggers as Prisma.InputJsonValue | undefined,
        graph: parsed.data.graph as Prisma.InputJsonValue | undefined,
      },
    });
    return reply.send(workflow);
  });

  app.delete("/automation/workflows/:id", { preHandler: requirePermission("automations.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.automationWorkflow.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) return reply.status(404).send({ error: "Automação não encontrada" });

    await prisma.$transaction([
      prisma.automationWorkflowRun.deleteMany({ where: { workflowId: id } }),
      prisma.automationWorkflow.delete({ where: { id } }),
    ]);
    return reply.status(204).send();
  });

  // Registros de execução — uma linha por contato/evento inscrito, com o
  // log de cada passo.
  app.get("/automation/workflows/:id/runs", { preHandler: requirePermission("automations.view") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;
    const workflow = await prisma.automationWorkflow.findFirst({ where: { id, tenantId } });
    if (!workflow) return reply.status(404).send({ error: "Automação não encontrada" });

    const runs = await prisma.automationWorkflowRun.findMany({
      where: { workflowId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const contactIds = [...new Set(runs.map((r) => r.contactId).filter((c): c is string => !!c))];
    const contacts = await prisma.contact.findMany({
      where: { id: { in: contactIds }, tenantId },
      select: { id: true, name: true, phone: true },
    });
    const contactById = new Map(contacts.map((c) => [c.id, c]));

    return reply.send(runs.map((r) => ({ ...r, contact: r.contactId ? contactById.get(r.contactId) ?? null : null })));
  });
}

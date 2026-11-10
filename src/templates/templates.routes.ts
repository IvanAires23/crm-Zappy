import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { authenticate, requirePermission } from "../auth/auth.plugin.js";
import { MARKERS } from "../automation/context.js";
import {
  createMetaTemplate,
  deleteMetaTemplate,
  getTenantProvider,
  graphErrorMessage,
  listMetaTemplates,
} from "../whatsapp/client.js";
import { buildMetaComponents, countPositionalVariables, positionalProblem } from "./templateService.js";

function firstZodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Dados inválidos";
  const where = issue.path.length ? ` (${issue.path.join(".")})` : "";
  return `${issue.message}${where}`;
}

const listQuerySchema = z.object({
  status: z.enum(["draft", "pending", "approved", "rejected", "paused", "disabled"]).optional(),
  type: z.enum(["waba", "internal"]).optional(),
});

const buttonSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("QUICK_REPLY"), text: z.string().trim().min(1, "Texto do botão").max(25, "Botão: no máximo 25 caracteres") }),
  z.object({
    type: z.literal("URL"),
    text: z.string().trim().min(1, "Texto do botão").max(25, "Botão: no máximo 25 caracteres"),
    url: z.string().trim().url("URL do botão inválida"),
  }),
  z.object({
    type: z.literal("PHONE_NUMBER"),
    text: z.string().trim().min(1, "Texto do botão").max(25, "Botão: no máximo 25 caracteres"),
    phone: z.string().trim().regex(/^\+?\d{8,15}$/, "Telefone do botão inválido (só dígitos, com DDI)"),
  }),
]);

const baseFields = {
  category: z.string().trim().min(1).max(40),
  language: z.string().trim().min(2).max(10),
  headerText: z.string().trim().max(60, "Cabeçalho: no máximo 60 caracteres").nullable().optional(),
  bodyText: z.string().trim().min(1, "Escreva o texto do modelo").max(1024, "Corpo: no máximo 1024 caracteres"),
  footerText: z.string().trim().max(60, "Rodapé: no máximo 60 caracteres").nullable().optional(),
  buttons: z.array(buttonSchema).max(10, "No máximo 10 botões").optional(),
  variableMap: z.array(z.string().trim().max(200)).max(20).optional(),
};

const createSchema = z.object({
  type: z.enum(["waba", "internal"]),
  name: z.string().trim().min(1, "Informe um nome").max(120),
  ...baseFields,
  category: baseFields.category.default("UTILITY"),
  language: baseFields.language.default("pt_BR"),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  ...Object.fromEntries(Object.entries(baseFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
}) as z.ZodType<Partial<z.infer<typeof createSchema>>>;

const WABA_NAME = /^[a-z0-9_]+$/;
const WABA_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"];

// Regras que a Meta aplica na submissão — checadas antes pra o erro sair
// em português e apontando o campo, em vez do erro genérico da Graph.
function wabaProblem(t: {
  name: string;
  category: string;
  headerText?: string | null;
  bodyText: string;
  buttons?: { type: string }[];
}): string | null {
  if (!WABA_NAME.test(t.name)) return "Nome de template oficial: só letras minúsculas, números e _ (ex: boas_vindas_1)";
  if (!WABA_CATEGORIES.includes(t.category)) return "Categoria precisa ser MARKETING, UTILITY ou AUTHENTICATION";
  if (t.headerText && /\{\{/.test(t.headerText)) return "Variáveis no cabeçalho não são suportadas — use só no corpo";
  const positional = positionalProblem(t.bodyText);
  if (positional) return positional;
  if (/\{\{\s*[a-zA-Z]/.test(t.bodyText)) {
    return "Template oficial usa {{1}}, {{2}}... no texto — escolha o marcador do CRM de cada variável abaixo";
  }
  if (/^\s*\{\{\s*\d+\s*\}\}|\{\{\s*\d+\s*\}\}\s*$/.test(t.bodyText)) {
    return "A Meta não aceita o texto começando ou terminando com uma variável";
  }
  const buttons = t.buttons ?? [];
  const quick = buttons.filter((b) => b.type === "QUICK_REPLY").length;
  if (buttons.filter((b) => b.type === "URL").length > 2) return "No máximo 2 botões de link";
  if (buttons.filter((b) => b.type === "PHONE_NUMBER").length > 1) return "No máximo 1 botão de telefone";
  if (quick > 0 && quick < buttons.length && buttons.findIndex((b) => b.type !== "QUICK_REPLY") < buttons.findIndex((b) => b.type === "QUICK_REPLY")) {
    return "Coloque as respostas rápidas antes dos botões de link/telefone";
  }
  return null;
}

const META_STATUS: Record<string, string> = {
  APPROVED: "approved",
  PENDING: "pending",
  IN_APPEAL: "pending",
  REJECTED: "rejected",
  PAUSED: "paused",
  DISABLED: "disabled",
};

export async function templatesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/templates", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const tenantId = request.auth.tenantId;
    const { status, type } = parsed.data;

    const templates = await prisma.template.findMany({
      where: { tenantId, ...(status ? { metaStatus: status } : {}), ...(type ? { type } : {}) },
      orderBy: { name: "asc" },
    });

    return reply.send(templates);
  });

  // Marcadores disponíveis pros editores (mesma ideia dos markers do Kommo).
  app.get("/templates/markers", async (request, reply) => {
    const fields = await prisma.dealCustomFieldDefinition.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { order: "asc" },
      select: { name: true },
    });
    return reply.send([
      ...MARKERS.map(({ marker, label }) => ({ marker, label })),
      ...fields.map((f) => ({ marker: `{{deal.fields.${f.name.trim().toLowerCase()}}}`, label: `Campo: ${f.name}` })),
    ]);
  });

  app.post("/templates", { preHandler: requirePermission("templates.manage") }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    const tenantId = request.auth.tenantId;
    const data = parsed.data;

    if (data.type === "waba") {
      const problem = wabaProblem(data);
      if (problem) return reply.status(400).send({ error: problem });
    }

    const clash = await prisma.template.findFirst({ where: { tenantId, name: data.name, language: data.language } });
    if (clash) return reply.status(409).send({ error: "Já existe um modelo com esse nome e idioma" });

    const template = await prisma.template.create({
      data: {
        tenantId,
        type: data.type,
        name: data.name,
        category: data.category,
        language: data.language,
        headerText: data.headerText || null,
        bodyText: data.bodyText,
        footerText: data.footerText || null,
        buttons: (data.buttons ?? []) as Prisma.InputJsonValue,
        variableMap: (data.variableMap ?? []).slice(0, countPositionalVariables(data.bodyText)) as Prisma.InputJsonValue,
        // Modelo interno não passa por aprovação — já nasce utilizável.
        metaStatus: data.type === "internal" ? "approved" : "draft",
      },
    });
    return reply.status(201).send(template);
  });

  // Igual ao Kommo: template oficial só edita em rascunho ou recusado — o
  // que está em análise ou aprovado na Meta fica travado.
  app.patch("/templates/:id", { preHandler: requirePermission("templates.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: firstZodMessage(parsed.error) });

    const existing = await prisma.template.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Modelo não encontrado" });

    const data = parsed.data;
    const onlyMapping = Object.keys(data).every((k) => k === "variableMap");
    if (existing.type === "waba" && !["draft", "rejected"].includes(existing.metaStatus) && !onlyMapping) {
      return reply.status(409).send({
        error: "Template em análise ou aprovado não pode ser editado — crie um novo (só os marcadores das variáveis podem mudar)",
      });
    }

    const merged = {
      name: data.name ?? existing.name,
      category: data.category ?? existing.category,
      headerText: data.headerText === undefined ? existing.headerText : data.headerText || null,
      bodyText: data.bodyText ?? existing.bodyText,
      footerText: data.footerText === undefined ? existing.footerText : data.footerText || null,
      buttons: data.buttons ?? (existing.buttons as unknown as { type: string }[]),
    };
    if (existing.type === "waba" && !onlyMapping) {
      const problem = wabaProblem(merged);
      if (problem) return reply.status(400).send({ error: problem });
    }

    const template = await prisma.template.update({
      where: { id },
      data: {
        ...merged,
        language: data.language ?? existing.language,
        buttons: merged.buttons as Prisma.InputJsonValue,
        variableMap:
          data.variableMap !== undefined
            ? (data.variableMap.slice(0, countPositionalVariables(merged.bodyText)) as Prisma.InputJsonValue)
            : undefined,
        // Editar um recusado volta pra rascunho — precisa reenviar.
        ...(existing.type === "waba" && existing.metaStatus === "rejected" && !onlyMapping
          ? { metaStatus: "draft", rejectedReason: null }
          : {}),
      },
    });
    return reply.send(template);
  });

  app.delete("/templates/:id", { preHandler: requirePermission("templates.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;
    const existing = await prisma.template.findFirst({ where: { id, tenantId }, include: { _count: { select: { broadcasts: true } } } });
    if (!existing) return reply.status(404).send({ error: "Modelo não encontrado" });
    if (existing._count.broadcasts > 0) {
      return reply.status(409).send({ error: "Esse template já foi usado em disparos — não dá pra excluir sem perder o histórico" });
    }

    // Apaga na Meta também (o nome fica "reservado" lá por 30 dias).
    if (existing.type === "waba" && existing.metaStatus !== "draft") {
      try {
        await deleteMetaTemplate(tenantId, existing.name, existing.metaTemplateId);
      } catch (err) {
        return reply.status(502).send({ error: `A Meta recusou a exclusão: ${graphErrorMessage(err)}` });
      }
    }
    await prisma.template.delete({ where: { id } });
    return reply.status(204).send();
  });

  // Envia o rascunho pra análise da Meta (Cloud API oficial).
  app.post("/templates/:id/submit", { preHandler: requirePermission("templates.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth.tenantId;
    const template = await prisma.template.findFirst({ where: { id, tenantId } });
    if (!template) return reply.status(404).send({ error: "Modelo não encontrado" });
    if (template.type !== "waba") return reply.status(400).send({ error: "Modelo interno não precisa de aprovação" });
    if (!["draft", "rejected"].includes(template.metaStatus)) {
      return reply.status(409).send({ error: "Esse template já foi enviado pra Meta" });
    }
    if ((await getTenantProvider(tenantId)) !== "cloud_api") {
      return reply.status(409).send({ error: "Templates oficiais exigem a conexão pela API oficial (Cloud API)" });
    }
    const problem = wabaProblem({ ...template, buttons: template.buttons as unknown as { type: string }[] });
    if (problem) return reply.status(400).send({ error: problem });

    try {
      const result = await createMetaTemplate(tenantId, {
        name: template.name,
        language: template.language,
        category: template.category,
        components: buildMetaComponents(template),
      });
      const updated = await prisma.template.update({
        where: { id },
        data: {
          metaTemplateId: result.id,
          metaStatus: META_STATUS[result.status] ?? "pending",
          category: result.category ?? template.category,
          rejectedReason: null,
        },
      });
      return reply.send(updated);
    } catch (err) {
      return reply.status(502).send({ error: `A Meta recusou o template: ${graphErrorMessage(err)}` });
    }
  });

  // Puxa da WABA o status de todos os templates (e importa os criados
  // direto no Gerenciador do WhatsApp). Os marcadores já escolhidos aqui
  // são mantidos.
  app.post("/templates/sync", { preHandler: requirePermission("templates.manage") }, async (request, reply) => {
    const tenantId = request.auth.tenantId;
    if ((await getTenantProvider(tenantId)) !== "cloud_api") {
      return reply.status(409).send({ error: "Sincronizar só funciona com a API oficial (Cloud API) conectada" });
    }

    let remote;
    try {
      remote = await listMetaTemplates(tenantId);
    } catch (err) {
      return reply.status(502).send({ error: `Não deu pra ler os templates da Meta: ${graphErrorMessage(err)}` });
    }

    let created = 0;
    let updated = 0;
    for (const t of remote) {
      const header = t.components?.find((c) => c.type === "HEADER" && c.format === "TEXT")?.text ?? null;
      const body = t.components?.find((c) => c.type === "BODY")?.text ?? "";
      const footer = t.components?.find((c) => c.type === "FOOTER")?.text ?? null;
      const buttons = (t.components?.find((c) => c.type === "BUTTONS")?.buttons ?? [])
        .filter((b) => ["QUICK_REPLY", "URL", "PHONE_NUMBER"].includes(b.type))
        .map((b) => ({ type: b.type, text: b.text, ...(b.url ? { url: b.url } : {}), ...(b.phone_number ? { phone: b.phone_number } : {}) }));
      const data = {
        type: "waba",
        category: t.category,
        headerText: header,
        bodyText: body,
        footerText: footer,
        buttons: buttons as Prisma.InputJsonValue,
        metaStatus: META_STATUS[t.status] ?? "pending",
        metaTemplateId: t.id,
        rejectedReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
      };
      const existing = await prisma.template.findFirst({ where: { tenantId, name: t.name, language: t.language } });
      if (existing) {
        await prisma.template.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        await prisma.template.create({ data: { tenantId, name: t.name, language: t.language, ...data } });
        created++;
      }
    }
    return reply.send({ total: remote.length, created, updated });
  });
}

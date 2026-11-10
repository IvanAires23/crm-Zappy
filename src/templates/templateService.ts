import type { Template } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { outboundQueue } from "../queue/queue.js";
import { publishRealtimeEvent } from "../realtime/bus.js";
import { getTenantProvider } from "../whatsapp/client.js";
import { isMessagingRestricted } from "../whatsapp/window.js";
import { interpolate } from "../automation/actions.js";
import { buildContext, markerSample, type WorkflowContext } from "../automation/context.js";

export interface TemplateButton {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
  text: string;
  url?: string;
  phone?: string;
}

// Quantas variáveis posicionais ({{1}}, {{2}}...) o texto usa — a Meta
// exige que sejam sequenciais começando em 1.
export function countPositionalVariables(text: string): number {
  const nums = [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export function positionalProblem(text: string): string | null {
  const nums = [...new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  if (nums.some((n, i) => n !== i + 1)) return "As variáveis precisam ser sequenciais: {{1}}, {{2}}, {{3}}...";
  return null;
}

function renderMarkers(text: string, ctx: WorkflowContext | null): string {
  if (!ctx) return text;
  return String(interpolate(text, ctx as unknown as Record<string, unknown>));
}

// Valores de cada {{N}}: os informados na mão ganham; o resto sai do
// variableMap (marcadores do CRM) aplicado sobre o contexto do contato.
export function resolveVariables(template: Template, ctx: WorkflowContext | null, manual?: string[]): string[] {
  const map = (template.variableMap as unknown as string[]) ?? [];
  const count = countPositionalVariables(template.bodyText);
  return Array.from({ length: count }, (_, i) => {
    const typed = manual?.[i];
    if (typed !== undefined && typed !== "") return typed;
    const marker = map[i];
    return marker ? renderMarkers(marker, ctx).trim() : "";
  });
}

function replacePositional(text: string, values: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index) => values[Number(index) - 1] || match);
}

// Texto completo como o cliente vê (cabeçalho + corpo + rodapé), usado no
// histórico da conversa e no envio de modelo interno / Baileys.
export function renderTemplateText(template: Template, ctx: WorkflowContext | null, values: string[]): string {
  const parts = [template.headerText ? `*${template.headerText}*` : null, replacePositional(template.bodyText, values), template.footerText ? `_${template.footerText}_` : null];
  return renderMarkers(parts.filter(Boolean).join("\n\n"), ctx).trim();
}

// Exemplo por variável pra submissão à Meta (obrigatório quando o corpo
// tem {{N}}).
export function exampleValues(template: Pick<Template, "bodyText" | "variableMap">): string[] {
  const map = (template.variableMap as unknown as string[]) ?? [];
  return Array.from({ length: countPositionalVariables(template.bodyText) }, (_, i) => markerSample(map[i] ?? "exemplo"));
}

export function buildMetaComponents(template: Template) {
  const components: Record<string, unknown>[] = [];
  if (template.headerText) components.push({ type: "HEADER", format: "TEXT", text: template.headerText });
  const examples = exampleValues(template);
  components.push({
    type: "BODY",
    text: template.bodyText,
    ...(examples.length ? { example: { body_text: [examples] } } : {}),
  });
  if (template.footerText) components.push({ type: "FOOTER", text: template.footerText });
  const buttons = (template.buttons as unknown as TemplateButton[]) ?? [];
  if (buttons.length) {
    components.push({
      type: "BUTTONS",
      buttons: buttons.map((b) =>
        b.type === "URL"
          ? { type: "URL", text: b.text, url: b.url }
          : b.type === "PHONE_NUMBER"
            ? { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone }
            : { type: "QUICK_REPLY", text: b.text }
      ),
    });
  }
  return components;
}

export class TemplateSendError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

// Envia um template (oficial ou interno) numa conversa. Mesmo caminho pra
// atendente (rota de conversa) e pra automação (ação send_template).
export async function sendTemplateToConversation(opts: {
  tenantId: string;
  conversationId: string;
  template: Template;
  variables?: string[];
  ctx?: WorkflowContext | null;
  source?: string;
}) {
  const { tenantId, template } = opts;
  const conversation = await prisma.conversation.findFirst({
    where: { id: opts.conversationId, tenantId },
    include: { contact: true },
  });
  if (!conversation) throw new TemplateSendError("Conversa não encontrada", 404);

  const ctx =
    opts.ctx ??
    (await buildContext(tenantId, "template.send", { contactId: conversation.contactId, conversationId: conversation.id }));
  const values = resolveVariables(template, ctx, opts.variables);
  const text = renderTemplateText(template, ctx, values);
  if (!text) throw new TemplateSendError("O modelo ficou vazio depois de preencher os marcadores");

  const provider = await getTenantProvider(tenantId);
  // Template oficial só existe na Cloud API. Na API não oficial (Baileys)
  // não há janela de 24h nem aprovação — manda o texto renderizado.
  const asOfficialTemplate = template.type === "waba" && provider === "cloud_api";

  if (asOfficialTemplate) {
    if (template.metaStatus !== "approved") throw new TemplateSendError("Esse template ainda não foi aprovado pela Meta");
    if (values.some((v) => !v)) {
      throw new TemplateSendError("Preencha todas as variáveis do template (algum marcador ficou vazio para este contato)", 400);
    }
  } else if (isMessagingRestricted(provider, conversation.lastInboundMessageAt)) {
    throw new TemplateSendError(
      template.type === "internal"
        ? "Fora da janela de 24h — modelos internos são texto livre; use um template aprovado pela Meta"
        : "Fora da janela de 24h — envie um template aprovado pela Meta"
    );
  }

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        direction: "outbound",
        type: asOfficialTemplate ? "template" : "text",
        content: { text, templateName: template.name, templateId: template.id },
        status: "pending",
        ...(opts.source ? { source: opts.source } : {}),
      },
    });
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return created;
  });

  const components = values.length ? [{ type: "body", parameters: values.map((v) => ({ type: "text", text: v })) }] : undefined;
  await outboundQueue.add("send-message", {
    tenantId,
    messageId: message.id,
    to: conversation.contact.phone,
    ...(asOfficialTemplate
      ? { template: { name: template.name, languageCode: template.language, components } }
      : { text }),
  });

  await publishRealtimeEvent({ tenantId, event: "message:new", data: { conversationId: conversation.id, message } });
  return message;
}

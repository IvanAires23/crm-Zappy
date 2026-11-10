import { prisma } from "../db/prisma.js";

// ------------------------------------------------------------------
// Contexto: o que filtros, condições e marcadores ({{contact.name}})
// enxergam. Montado de novo a cada passo de um fluxo, pra que uma tag
// adicionada num passo anterior já valha numa condição depois de uma
// espera. Também é a fonte dos marcadores de template (estilo Kommo).
// ------------------------------------------------------------------

export interface WorkflowContext {
  event: string;
  trigger: Record<string, unknown>;
  contact: {
    id: string;
    name: string | null;
    firstName: string;
    phone: string;
    tags: string[];
  } | null;
  deal: {
    id: string;
    number: number;
    title: string;
    status: string;
    stageId: string;
    stageName: string;
    pipelineId: string;
    pipelineName: string;
    value: string; // "R$ 1.234,00" — pronto pra mensagem
    valueCents: number | null;
    assignedUserId: string | null;
    assignedUserName: string | null;
    tags: string[];
    // Campos personalizados por NOME (minúsculo) e por id — {{deal.fields.cpf}}
    fields: Record<string, string>;
  } | null;
  conversation: { id: string; status: string; assignedUserId: string | null; assignedUserName: string | null } | null;
  message: { text: string; channel: string } | null;
}

function contactIdFrom(data: Record<string, unknown>): string | null {
  if (typeof data.contactId === "string") return data.contactId;
  const contact = data.contact as { id?: unknown } | null | undefined;
  return contact && typeof contact.id === "string" ? contact.id : null;
}

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

export async function buildContext(
  tenantId: string,
  event: string,
  data: Record<string, unknown>,
  dealIdHint?: string | null
): Promise<WorkflowContext> {
  const explicitDealId = (typeof data.dealId === "string" ? data.dealId : null) ?? dealIdHint ?? null;
  let contactId = contactIdFrom(data);

  const dealInclude = {
    stage: true,
    pipeline: { select: { name: true } },
    assignedUser: { select: { name: true } },
    tags: { include: { tag: true } },
  } as const;

  const explicitDeal = explicitDealId
    ? await prisma.deal.findFirst({ where: { id: explicitDealId, tenantId }, include: dealInclude })
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
          include: dealInclude,
        })
      : null);

  const conversationId = typeof data.conversationId === "string" ? data.conversationId : null;
  const conversation = conversationId
    ? await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        include: { assignedUser: { select: { name: true } } },
      })
    : contact
      ? await prisma.conversation.findFirst({
          where: { tenantId, contactId: contact.id },
          orderBy: { lastMessageAt: "desc" },
          include: { assignedUser: { select: { name: true } } },
        })
      : null;

  let fields: Record<string, string> = {};
  if (deal) {
    const values = (deal.customFields ?? {}) as Record<string, unknown>;
    const ids = Object.keys(values);
    if (ids.length > 0) {
      const defs = await prisma.dealCustomFieldDefinition.findMany({ where: { tenantId, id: { in: ids } } });
      fields = Object.fromEntries(
        defs.flatMap((d) => [
          [d.name.trim().toLowerCase(), formatFieldValue(values[d.id])],
          [d.id, formatFieldValue(values[d.id])],
        ])
      );
    }
  }

  const text = typeof data.text === "string" ? data.text : null;
  const name = contact?.name?.trim() || null;

  return {
    event,
    trigger: data,
    contact: contact
      ? {
          id: contact.id,
          name,
          firstName: name ? name.split(/\s+/)[0] : "",
          phone: contact.phone,
          tags: contact.tags.map((t) => t.tag.name),
        }
      : null,
    deal: deal
      ? {
          id: deal.id,
          number: deal.number,
          title: deal.title,
          status: deal.status,
          stageId: deal.stageId,
          stageName: deal.stage.name,
          pipelineId: deal.pipelineId,
          pipelineName: deal.pipeline.name,
          value: deal.valueCents != null ? brl.format(deal.valueCents / 100) : "",
          valueCents: deal.valueCents,
          assignedUserId: deal.assignedUserId,
          assignedUserName: deal.assignedUser?.name ?? null,
          tags: deal.tags.map((t) => t.tag.name),
          fields,
        }
      : null,
    conversation: conversation
      ? {
          id: conversation.id,
          status: conversation.status,
          assignedUserId: conversation.assignedUserId,
          assignedUserName: conversation.assignedUser?.name ?? null,
        }
      : null,
    message: text !== null ? { text, channel: typeof data.channel === "string" ? data.channel : "whatsapp" } : null,
  };
}

// Catálogo dos marcadores que o front oferece nos editores de mensagem e
// template (mesma ideia dos "markers" do Kommo). `sample` vira exemplo na
// submissão de template pra Meta, que exige um valor por variável.
export const MARKERS: { marker: string; label: string; sample: string }[] = [
  { marker: "{{contact.name}}", label: "Nome do contato", sample: "Maria Souza" },
  { marker: "{{contact.firstName}}", label: "Primeiro nome do contato", sample: "Maria" },
  { marker: "{{contact.phone}}", label: "Telefone do contato", sample: "5511999998888" },
  { marker: "{{deal.title}}", label: "Título da oportunidade", sample: "Plano anual" },
  { marker: "{{deal.number}}", label: "Número da oportunidade", sample: "1024" },
  { marker: "{{deal.value}}", label: "Valor da oportunidade", sample: "R$ 1.500,00" },
  { marker: "{{deal.stageName}}", label: "Estágio da oportunidade", sample: "Proposta enviada" },
  { marker: "{{deal.pipelineName}}", label: "Pipeline da oportunidade", sample: "Vendas" },
  { marker: "{{deal.assignedUserName}}", label: "Responsável pela oportunidade", sample: "João" },
  { marker: "{{conversation.assignedUserName}}", label: "Atendente da conversa", sample: "João" },
];

export function markerSample(marker: string): string {
  const known = MARKERS.find((m) => m.marker === marker.replace(/\s+/g, ""));
  if (known) return known.sample;
  // Campo personalizado ({{deal.fields.cpf}}) ou texto fixo.
  return marker.includes("{{") ? "exemplo" : marker;
}

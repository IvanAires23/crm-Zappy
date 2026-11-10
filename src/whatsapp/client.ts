import { env } from "../config/env.js";
import { decryptToken } from "../config/crypto.js";
import { prisma } from "../db/prisma.js";
import { unofficialSendQueue, unofficialSendQueueEvents } from "../queue/queue.js";

const GRAPH_BASE = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

// Tempo de espera pela resposta do worker de Baileys (que segura o socket
// de verdade — ver src/workers/baileys.worker.ts) via a fila
// whatsapp-unofficial-send. Generoso porque o envio em si é rápido, mas o
// job pode ficar um instante na fila se o worker estiver ocupado.
const UNOFFICIAL_SEND_TIMEOUT_MS = 30_000;

// Um tenant pode ter duas linhas (cloud_api e baileys) se conectou as duas
// em momentos diferentes. Vale a última conexão feita pelo usuário — sem
// ordem, o findFirst devolvia qualquer uma (ex: a sessão Baileys antiga
// escondia a conexão oficial recém-feita). Não usar updatedAt: o Baileys
// regrava a linha a cada creds.update e sempre "ganharia".
export const CURRENT_ACCOUNT_ORDER = { connectedAt: "desc" } as const;

class WhatsappApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`WhatsApp API error (${status})`);
  }
}

async function getTenantAccount(tenantId: string) {
  const account = await prisma.tenantWhatsappAccount.findFirst({
    where: { tenantId, tokenStatus: "active" },
    orderBy: CURRENT_ACCOUNT_ORDER,
  });

  if (!account) {
    throw new Error(`Tenant ${tenantId} não tem conta WhatsApp ativa`);
  }

  return account;
}

// Pra decisões que dependem só de "qual provider esse tenant usa" (ex: a
// janela de 24h, que é uma regra só da Cloud API oficial) — não lança se
// não achar conta, porque essas decisões têm um fallback razoável (ver
// isMessagingRestricted em src/whatsapp/window.ts).
export async function getTenantProvider(tenantId: string): Promise<string | null> {
  const account = await prisma.tenantWhatsappAccount.findFirst({
    where: { tenantId, tokenStatus: "active" },
    orderBy: CURRENT_ACCOUNT_ORDER,
  });
  return account?.provider ?? null;
}

async function getTenantCredentials(tenantId: string) {
  const account = await getTenantAccount(tenantId);

  if (account.provider !== "cloud_api" || !account.accessTokenEncrypted) {
    throw new Error(
      `Tenant ${tenantId} não usa a Cloud API oficial (provider=${account.provider}) — essa operação só existe pra esse provider`
    );
  }

  return {
    phoneNumberId: account.phoneNumberId,
    wabaId: account.wabaId,
    accessToken: decryptToken(account.accessTokenEncrypted),
  };
}

// Envio pela API não oficial (Baileys/QR Code): o socket de verdade só
// existe no processo do worker dedicado, então a mensagem vai por uma fila
// BullMQ e esperamos o job terminar — dá pra tratar como uma chamada
// normal (await) mesmo estando em outro processo.
async function sendTextViaUnofficial(tenantId: string, to: string, text: string) {
  const job = await unofficialSendQueue.add("send-text", { tenantId, to, text });
  const result = await job.waitUntilFinished(unofficialSendQueueEvents, UNOFFICIAL_SEND_TIMEOUT_MS);
  return { messages: [{ id: result?.id ?? undefined }] };
}

async function graphRequest(path: string, accessToken: string, body: unknown) {
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();

  if (!res.ok) {
    throw new WhatsappApiError(res.status, json);
  }

  return json;
}

async function graphGet(path: string, accessToken: string) {
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const json = await res.json();

  if (!res.ok) {
    throw new WhatsappApiError(res.status, json);
  }

  return json;
}

// Coexistência: número que continua ativo no WhatsApp Business App (celular)
// além da Cloud API. Ver docs Meta "Onboard WhatsApp Business app users".
export async function checkCoexistenceStatus(phoneNumberId: string, accessToken: string) {
  const result = await graphGet(
    `${phoneNumberId}?fields=is_on_biz_app,platform_type`,
    accessToken
  );

  return {
    isOnBizApp: Boolean(result.is_on_biz_app),
    platformType: result.platform_type as string | undefined,
  };
}

// Dispara a sincronização de contatos e/ou histórico de mensagens do app pra
// Cloud API. A resposta chega depois, de forma assíncrona, via webhook
// (campos smb_app_state_sync e history) — não no retorno dessa chamada.
export async function triggerSmbAppDataSync(
  phoneNumberId: string,
  accessToken: string,
  syncType: "smb_app_state_sync" | "history"
) {
  return graphRequest(`${phoneNumberId}/smb_app_data`, accessToken, {
    messaging_product: "whatsapp",
    sync_type: syncType,
  });
}

export async function sendTextMessage(tenantId: string, to: string, text: string) {
  const account = await getTenantAccount(tenantId);

  if (account.provider === "baileys") {
    return sendTextViaUnofficial(tenantId, to, text);
  }

  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId);

  return graphRequest(`${phoneNumberId}/messages`, accessToken, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}

export interface ReplyButton {
  id: string;
  title: string;
}

// Menu numerado — usado na API não oficial (WhatsApp Web não entrega
// botões interativos de forma confiável) e guardado como texto da mensagem.
export function numberedMenuText(text: string, buttons: ReplyButton[]): string {
  return `${text}\n\n${buttons.map((b, i) => `${i + 1} - ${b.title}`).join("\n")}`;
}

// Mensagem com botões de resposta (Salesbot). Cloud API: até 3 = botões
// nativos (título até 20 caracteres); 4 a 10 = lista. Só vale dentro da
// janela de 24h, igual texto livre.
export async function sendButtonsMessage(tenantId: string, to: string, text: string, buttons: ReplyButton[]) {
  const account = await getTenantAccount(tenantId);
  if (account.provider === "baileys") {
    return sendTextViaUnofficial(tenantId, to, numberedMenuText(text, buttons));
  }

  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId);
  const interactive =
    buttons.length <= 3
      ? {
          type: "button",
          body: { text },
          action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        }
      : {
          type: "list",
          body: { text },
          action: {
            button: "Ver opções",
            sections: [{ title: "Opções", rows: buttons.map((b) => ({ id: b.id, title: b.title.slice(0, 24) })) }],
          },
        };

  return graphRequest(`${phoneNumberId}/messages`, accessToken, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive,
  });
}

// Sobe o arquivo pro Meta e devolve o media id — a mensagem em si é enviada
// depois com sendMediaMessage() referenciando esse id (a Meta hospeda o
// arquivo, não guardamos cópia nenhuma do nosso lado).
export async function uploadMedia(tenantId: string, buffer: Buffer, mimeType: string, filename: string) {
  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([Uint8Array.from(buffer)], { type: mimeType }), filename);

  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  const json = await res.json();
  if (!res.ok) {
    throw new WhatsappApiError(res.status, json);
  }
  return json as { id: string };
}

export async function sendMediaMessage(
  tenantId: string,
  to: string,
  type: "image" | "video" | "audio" | "document",
  mediaId: string,
  options?: { caption?: string; filename?: string }
) {
  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId);

  const mediaObject: Record<string, unknown> = { id: mediaId };
  // Áudio não aceita legenda na API da Meta — ela ignora silenciosamente,
  // mas evitamos mandar o campo pra não confundir quem depurar o payload.
  if (options?.caption && type !== "audio") mediaObject.caption = options.caption;
  if (options?.filename && type === "document") mediaObject.filename = options.filename;

  return graphRequest(`${phoneNumberId}/messages`, accessToken, {
    messaging_product: "whatsapp",
    to,
    type,
    [type]: mediaObject,
  });
}

// Resolve a URL temporária (~5min) da Meta pro media id e baixa os bytes —
// usado pelo proxy autenticado que serve mídia pro front (nem inbound nem
// outbound ficam guardados localmente, só o media id).
export async function downloadMedia(tenantId: string, mediaId: string) {
  const { accessToken } = await getTenantCredentials(tenantId);

  const meta = await graphGet(mediaId, accessToken);
  const fileRes = await fetch(meta.url as string, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileRes.ok) {
    throw new WhatsappApiError(fileRes.status, await fileRes.text());
  }

  return {
    buffer: Buffer.from(await fileRes.arrayBuffer()),
    mimeType: (meta.mime_type as string | undefined) ?? "application/octet-stream",
  };
}

export async function sendTemplateMessage(
  tenantId: string,
  to: string,
  templateName: string,
  languageCode: string,
  components?: unknown[]
) {
  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId);

  return graphRequest(`${phoneNumberId}/messages`, accessToken, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: components ?? [],
    },
  });
}

// --- Gestão de templates na WABA (message_templates) ---

async function getWabaCredentials(tenantId: string) {
  const creds = await getTenantCredentials(tenantId);
  if (!creds.wabaId) throw new Error("Conta oficial conectada sem WABA ID — reconecte o WhatsApp");
  return { wabaId: creds.wabaId, accessToken: creds.accessToken };
}

export interface MetaTemplate {
  id: string;
  name: string;
  status: string; // APPROVED | PENDING | REJECTED | PAUSED | DISABLED | IN_APPEAL
  category: string;
  language: string;
  rejected_reason?: string;
  components?: {
    type: string;
    format?: string;
    text?: string;
    buttons?: { type: string; text: string; url?: string; phone_number?: string }[];
  }[];
}

export async function createMetaTemplate(tenantId: string, payload: Record<string, unknown>) {
  const { wabaId, accessToken } = await getWabaCredentials(tenantId);
  return graphRequest(`${wabaId}/message_templates`, accessToken, payload) as Promise<{
    id: string;
    status: string;
    category: string;
  }>;
}

export async function listMetaTemplates(tenantId: string): Promise<MetaTemplate[]> {
  const { wabaId, accessToken } = await getWabaCredentials(tenantId);
  const all: MetaTemplate[] = [];
  let path: string | null =
    `${wabaId}/message_templates?fields=id,name,status,category,language,components,rejected_reason&limit=100`;
  // A Graph pagina por cursor; o `next` já vem com a URL completa.
  for (let page = 0; path && page < 20; page++) {
    const json = (await graphGet(path, accessToken)) as { data: MetaTemplate[]; paging?: { next?: string } };
    all.push(...json.data);
    path = json.paging?.next ? json.paging.next.replace(`${GRAPH_BASE}/`, "") : null;
  }
  return all;
}

export async function deleteMetaTemplate(tenantId: string, name: string, metaTemplateId?: string | null) {
  const { wabaId, accessToken } = await getWabaCredentials(tenantId);
  const qs = new URLSearchParams({ name, ...(metaTemplateId ? { hsm_id: metaTemplateId } : {}) });
  const res = await fetch(`${GRAPH_BASE}/${wabaId}/message_templates?${qs}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new WhatsappApiError(res.status, json);
  return json;
}

// Mensagem legível de um erro da Graph API (error_user_msg > message).
export function graphErrorMessage(err: unknown): string {
  if (err instanceof WhatsappApiError) {
    const e = (err.body as { error?: { error_user_msg?: string; error_user_title?: string; message?: string } })?.error;
    return e?.error_user_msg || e?.message || err.message;
  }
  return (err as Error).message;
}

export { WhatsappApiError };

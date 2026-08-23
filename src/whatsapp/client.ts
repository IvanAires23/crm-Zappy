import { env } from "../config/env.js";
import { decryptToken } from "../config/crypto.js";
import { prisma } from "../db/prisma.js";

const GRAPH_BASE = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

class WhatsappApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`WhatsApp API error (${status})`);
  }
}

async function getTenantCredentials(tenantId: string) {
  const account = await prisma.tenantWhatsappAccount.findFirst({
    where: { tenantId, tokenStatus: "active" },
  });

  if (!account) {
    throw new Error(`Tenant ${tenantId} não tem conta WhatsApp ativa`);
  }

  return {
    phoneNumberId: account.phoneNumberId,
    accessToken: decryptToken(account.accessTokenEncrypted),
  };
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
  const { phoneNumberId, accessToken } = await getTenantCredentials(tenantId);

  return graphRequest(`${phoneNumberId}/messages`, accessToken, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
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

export { WhatsappApiError };

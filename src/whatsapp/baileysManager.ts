import makeWASocket, { DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import { prisma } from "../db/prisma.js";
import { publishRealtimeEvent } from "../realtime/bus.js";
import { usePostgresAuthState } from "./baileysAuthState.js";

const logger = pino({ transport: { target: "pino-pretty" } });
const baileysLogger = pino({ level: "warn" }); // silencioso — só warn/error do próprio protocolo

// Uma sessão viva por tenant, mantida em memória neste processo (worker
// dedicado — ver src/workers/baileys.worker.ts). Reconectar depois de um
// restart do worker é feito relendo do banco todo TenantWhatsappAccount
// com provider=baileys e baileysStatus != logged_out (ver reconnectAll()).
const sockets = new Map<string, WASocket>();

// JID do WhatsApp é "<telefone>@s.whatsapp.net" (ou "...@lid" em alguns
// casos novos do multi-device) — guardamos o Contact só com o telefone puro
// (sem sufixo), no mesmo formato que a Cloud API manda em `msg.from`, pra
// um contato existente ser reconhecido independente de qual provider o
// tenant estiver usando.
function jidToPhone(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}
function phoneToJid(phone: string): string {
  return `${phone}@s.whatsapp.net`;
}

function syntheticPhoneNumberId(tenantId: string): string {
  return `baileys:${tenantId}`;
}

async function getOrCreateAccount(tenantId: string) {
  const existing = await prisma.tenantWhatsappAccount.findFirst({ where: { tenantId, provider: "baileys" } });
  if (existing) return existing;

  return prisma.tenantWhatsappAccount.create({
    data: {
      tenantId,
      provider: "baileys",
      phoneNumberId: syntheticPhoneNumberId(tenantId),
      tokenStatus: "active",
      baileysStatus: "connecting",
    },
  });
}

async function findOrCreateOpenConversation(tenantId: string, contactId: string) {
  const existing = await prisma.conversation.findFirst({
    where: { tenantId, contactId, status: { not: "closed" } },
  });
  if (existing) return existing;
  return prisma.conversation.create({ data: { tenantId, contactId, status: "open" } });
}

// Extrai um texto simples do payload de mensagem do Baileys — cobre os dois
// formatos mais comuns (texto simples e texto com resposta/formatação).
// Mídia (imagem/áudio/vídeo/documento) fica fora do escopo desta primeira
// versão da API não oficial; chega como "[tipo não suportado]" no histórico
// em vez de quebrar o processamento.
function extractText(message: any): string | undefined {
  return message?.conversation ?? message?.extendedTextMessage?.text;
}

async function ingestIncoming(tenantId: string, msg: any) {
  const remoteJid: string | undefined = msg.key?.remoteJid;
  // Grupos ("...@g.us") e broadcasts ficam fora do escopo do CRM (que é
  // 1:1 com o cliente) — nem vale criar Contact/Conversation pra eles.
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return;

  const phone = jidToPhone(remoteJid);
  const text = extractText(msg.message);
  const direction = msg.key.fromMe ? "outbound" : "inbound";

  const contact = await prisma.contact.upsert({
    where: { tenantId_phone: { tenantId, phone } },
    create: { tenantId, phone, name: msg.pushName ?? undefined },
    update: msg.pushName ? { name: msg.pushName } : {},
  });

  const conversation = await findOrCreateOpenConversation(tenantId, contact.id);

  const message = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      direction,
      type: text ? "text" : "unsupported",
      // Mesmo formato { text: { body } } usado pela Cloud API — o front lê
      // esse shape independente de qual provider gerou a mensagem.
      content: text ? { text: { body: text } } : { raw: "mídia ou tipo não suportado ainda" },
      whatsappMessageId: msg.key.id ?? undefined,
      status: direction === "inbound" ? "delivered" : "sent",
      // "business_app" é reaproveitado aqui pro mesmo sentido que já tem na
      // coexistência da Cloud API: mensagem mandada pelo próprio celular,
      // fora do CRM, mas que precisa aparecer na conversa.
      source: msg.key.fromMe ? "business_app" : "api",
    },
  });

  const now = new Date();
  await prisma.conversation.update({
    where: { id: conversation.id },
    data:
      direction === "inbound"
        ? { lastMessageAt: now, lastInboundMessageAt: now }
        : { lastMessageAt: now },
  });

  await publishRealtimeEvent({
    tenantId,
    event: "message:new",
    data: { conversationId: conversation.id, message },
  });
}

async function startSession(tenantId: string): Promise<void> {
  if (sockets.has(tenantId)) return; // já tem uma sessão viva pra esse tenant

  const account = await getOrCreateAccount(tenantId);
  const { state, saveCreds } = await usePostgresAuthState(account.id);

  const sock = makeWASocket({
    auth: state,
    logger: baileysLogger,
    // "CRM WhatsApp" aparece na lista de aparelhos conectados do usuário —
    // ajuda a identificar de onde veio a conexão se ele checar pelo celular.
    browser: ["CRM WhatsApp", "Chrome", "1.0.0"],
    syncFullHistory: false, // histórico completo fica fora do escopo do v1
  });

  sockets.set(tenantId, sock);
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      await prisma.tenantWhatsappAccount.update({
        where: { id: account.id },
        data: { baileysStatus: "qr_pending" },
      });
      await publishRealtimeEvent({ tenantId, event: "whatsapp:qr", data: { qr: qrDataUrl } });
    }

    if (connection === "open") {
      const displayPhoneNumber = sock.user?.id ? jidToPhone(sock.user.id) : undefined;
      await prisma.tenantWhatsappAccount.update({
        where: { id: account.id },
        data: { baileysStatus: "connected", displayPhoneNumber, tokenStatus: "active" },
      });
      await publishRealtimeEvent({ tenantId, event: "whatsapp:connected", data: { displayPhoneNumber } });
      logger.info({ tenantId }, "Sessão Baileys conectada");
    }

    if (connection === "close") {
      sockets.delete(tenantId);

      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      await prisma.tenantWhatsappAccount.update({
        where: { id: account.id },
        data: { baileysStatus: loggedOut ? "logged_out" : "disconnected" },
      });
      await publishRealtimeEvent({ tenantId, event: "whatsapp:disconnected", data: { loggedOut } });

      if (loggedOut) {
        logger.warn({ tenantId }, "Sessão Baileys deslogada pelo celular — precisa de um QR novo");
      } else {
        // Queda de rede/servidor da Meta reinicia sozinha — só logout manual
        // pelo celular exige um QR novo (as chaves antigas já foram
        // invalidadas do lado do WhatsApp).
        logger.warn({ tenantId, statusCode }, "Sessão Baileys caiu, reconectando");
        await startSession(tenantId);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return; // ignora replay de histórico, só mensagem em tempo real
    for (const msg of messages) {
      try {
        await ingestIncoming(tenantId, msg);
      } catch (err) {
        logger.error({ tenantId, err }, "Falha ao processar mensagem recebida via Baileys");
      }
    }
  });
}

async function logoutSession(tenantId: string): Promise<void> {
  const sock = sockets.get(tenantId);
  if (sock) {
    await sock.logout().catch(() => {}); // dispara "connection.update" com loggedOut=true, que já limpa o resto
    sockets.delete(tenantId);
  }

  await prisma.tenantWhatsappAccount.updateMany({
    where: { tenantId, provider: "baileys" },
    data: { baileysStatus: "logged_out" },
  });
}

// Envio usado por whatsapp/client.ts (via fila, ver queue.ts) — só texto
// livre por enquanto. Diferente da Cloud API, aqui não existe "janela de
// 24h" nem aprovação de template: é WhatsApp Web de verdade, então o
// comportamento é o mesmo que mandar pelo celular.
async function sendText(tenantId: string, toPhone: string, text: string): Promise<{ id: string | null }> {
  const sock = sockets.get(tenantId);
  if (!sock) {
    throw new Error(`Tenant ${tenantId} não tem sessão Baileys ativa (desconectado ou nunca conectou)`);
  }

  const result = await sock.sendMessage(phoneToJid(toPhone), { text });
  return { id: result?.key?.id ?? null };
}

// Reconecta, na subida do worker, todo tenant que já tinha uma sessão
// (mesmo que não esteja "connected" no momento — "qr_pending"/"connecting"
// também precisam de um socket vivo pra continuar o pareamento ou tentar de
// novo). "logged_out" fica de fora de propósito: as credenciais antigas já
// não servem, reconectar geraria erro em loop até o usuário escanear um QR
// novo pela tela.
async function reconnectAll(): Promise<void> {
  const accounts = await prisma.tenantWhatsappAccount.findMany({
    where: { provider: "baileys", baileysStatus: { in: ["connected", "connecting", "qr_pending"] } },
  });

  for (const account of accounts) {
    try {
      await startSession(account.tenantId);
    } catch (err) {
      logger.error({ tenantId: account.tenantId, err }, "Falha ao reconectar sessão Baileys existente");
    }
  }

  logger.info({ count: accounts.length }, "Reconexão de sessões Baileys existentes concluída");
}

export const baileysManager = { startSession, logoutSession, sendText, reconnectAll };

import { WhatsappApiError } from "./client.js";

// Códigos da Cloud API que mais aparecem pra um atendente, com o que fazer.
// Lista: developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const KNOWN_CODES: Record<number, string> = {
  190: "Token de acesso da Meta inválido ou expirado. Reconecte o WhatsApp em Configurações.",
  368: "A conta foi bloqueada temporariamente pela Meta por violação de política.",
  130429: "Limite de envio da conta atingido. Tente de novo em alguns minutos.",
  131000: "Erro interno da Meta. Tente enviar de novo.",
  131005: "A Meta negou o acesso: o app não tem permissão para enviar por este número.",
  131026: "Mensagem não entregue: o número pode não ter WhatsApp ou estar com o app desatualizado.",
  131030:
    "O número do cliente não está na lista de destinatários de teste do app. Coloque o app da Meta em modo Live " +
    "(ou adicione o número como destinatário de teste).",
  131031: "A conta do WhatsApp Business está bloqueada ou restrita pela Meta.",
  131042: "Problema de pagamento na conta do WhatsApp Business. Adicione um método de pagamento no Gerenciador do WhatsApp.",
  131047: "Passou de 24h desde a última mensagem do cliente. Fora dessa janela só dá para enviar template.",
  131049: "A Meta segurou a mensagem para preservar o engajamento desse cliente (limite de marketing).",
  131051: "Tipo de mensagem não suportado pela Meta.",
  131056: "Muitas mensagens para este mesmo número em pouco tempo. Aguarde e tente de novo.",
  133010: "O número não está registrado na Cloud API. Reconecte o WhatsApp em Configurações.",
};

const MAX_LENGTH = 500;

interface MetaError {
  code?: number;
  title?: string;
  message?: string;
  error_user_msg?: string;
  error_data?: { details?: string };
}

export function describeMetaError(error: MetaError | undefined | null): string {
  if (!error) return "A Meta recusou o envio sem informar o motivo.";
  const code = typeof error.code === "number" ? error.code : Number(error.code);
  const known = Number.isFinite(code) ? KNOWN_CODES[code] : undefined;
  const raw = error.error_user_msg ?? error.error_data?.details ?? error.message ?? error.title;
  const text = known ?? raw ?? "A Meta recusou o envio sem informar o motivo.";
  // O texto cru da Meta ajuda no suporte mesmo quando já traduzimos.
  const detail = known && raw && raw !== known ? ` Detalhe da Meta: ${raw}` : "";
  const suffix = Number.isFinite(code) ? ` (código ${code})` : "";
  return `${text}${detail}${suffix}`.slice(0, MAX_LENGTH);
}

// Erro lançado no envio (outbound worker): pode ser da Graph API ou nosso
// (sem conta ativa, timeout do worker de Baileys, etc.).
export function describeSendError(err: unknown): string {
  if (err instanceof WhatsappApiError) {
    const body = err.body as { error?: MetaError } | string | undefined;
    if (body && typeof body === "object" && body.error) return describeMetaError(body.error);
    return `A Meta recusou o envio (HTTP ${err.status}).`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_LENGTH);
}

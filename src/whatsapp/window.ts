const WINDOW_MS = 24 * 60 * 60 * 1000;

// Janela de 24h da Meta: texto/mídia livre só é aceito até 24h depois da
// última mensagem do CLIENTE — passado isso, só template. Usado tanto no
// envio imediato (conversations.routes.ts) quanto no envio agendado
// (automation.worker.ts), que precisa checar de novo no momento do tick.
export function isWithinWindow(lastInboundMessageAt: Date | null): boolean {
  if (!lastInboundMessageAt) return false;
  return Date.now() - lastInboundMessageAt.getTime() < WINDOW_MS;
}

// A janela de 24h é uma regra da Cloud API oficial da Meta (exige template
// aprovado fora dela) — não existe na API não oficial (Baileys/WhatsApp
// Web), que manda texto livre a qualquer momento, sem depender de
// aprovação de template. `provider` null (sem conta conectada ainda) cai
// no comportamento antigo, restringindo por segurança.
export function isMessagingRestricted(provider: string | null, lastInboundMessageAt: Date | null): boolean {
  if (provider === "baileys") return false;
  return !isWithinWindow(lastInboundMessageAt);
}

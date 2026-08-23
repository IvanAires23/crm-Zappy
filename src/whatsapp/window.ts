const WINDOW_MS = 24 * 60 * 60 * 1000;

// Janela de 24h da Meta: texto/mídia livre só é aceito até 24h depois da
// última mensagem do CLIENTE — passado isso, só template. Usado tanto no
// envio imediato (conversations.routes.ts) quanto no envio agendado
// (automation.worker.ts), que precisa checar de novo no momento do tick.
export function isWithinWindow(lastInboundMessageAt: Date | null): boolean {
  if (!lastInboundMessageAt) return false;
  return Date.now() - lastInboundMessageAt.getTime() < WINDOW_MS;
}

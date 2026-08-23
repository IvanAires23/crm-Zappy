import { connection } from "../queue/queue.js";
import type { RealtimeEnvelope } from "./events.js";

export const REALTIME_CHANNEL = "crm-realtime";

// Publica um evento pro tenant — chamado tanto pela API (rotas) quanto
// pelos workers, que rodam em processos separados do servidor HTTP. Só o
// processo da API (src/realtime/socket.ts) segura a instância do
// Socket.io e re-emite pros clientes conectados; aqui é só o publish.
export async function publishRealtimeEvent(envelope: RealtimeEnvelope): Promise<void> {
  await connection.publish(REALTIME_CHANNEL, JSON.stringify(envelope));
}

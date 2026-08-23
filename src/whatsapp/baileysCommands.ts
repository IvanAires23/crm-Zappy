import { connection } from "../queue/queue.js";

// Canal separado do REALTIME_CHANNEL (que é pro front) — aqui é só a API
// avisando o worker de Baileys pra agir (o worker é quem segura o socket
// vivo, processos diferentes, ver src/workers/baileys.worker.ts).
export const BAILEYS_COMMANDS_CHANNEL = "whatsapp-baileys-commands";

export interface BaileysCommand {
  tenantId: string;
  action: "start" | "logout";
}

export async function publishBaileysCommand(command: BaileysCommand): Promise<void> {
  await connection.publish(BAILEYS_COMMANDS_CHANNEL, JSON.stringify(command));
}

// Envelope publicado no Redis e re-emitido pro Socket.io — um único canal
// pro tenant inteiro, o cliente filtra pela sala (tenant:<id>) que já
// entrou no handshake. Ver src/realtime/bus.ts e src/realtime/socket.ts.
export interface RealtimeEnvelope {
  tenantId: string;
  event:
    | "message:new"
    | "message:status"
    | "conversation:read"
    | "conversation:assigned"
    // Conexão WhatsApp via API não oficial (Baileys/QR Code) — ver
    // src/whatsapp/baileysManager.ts. Emitidos pro mesmo canal por tenant
    // que o chat, o front só precisa ouvir mais três nomes de evento.
    | "whatsapp:qr"
    | "whatsapp:connected"
    | "whatsapp:disconnected";
  data: unknown;
}

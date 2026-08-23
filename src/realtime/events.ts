// Envelope publicado no Redis e re-emitido pro Socket.io — um único canal
// pro tenant inteiro, o cliente filtra pela sala (tenant:<id>) que já
// entrou no handshake. Ver src/realtime/bus.ts e src/realtime/socket.ts.
export interface RealtimeEnvelope {
  tenantId: string;
  event: "message:new" | "message:status" | "conversation:read";
  data: unknown;
}

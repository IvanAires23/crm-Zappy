import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { webhookQueue } from "../queue/queue.js";

export async function webhookRoutes(app: FastifyInstance) {
  // 1) Verificação do webhook (a Meta chama isso uma vez, ao configurar)
  app.get(
    "/webhook",
    // Sem rate limit: é a Meta chamando, autenticada pelo verify_token, não
    // um usuário — nada a ganhar limitando e um risco real de bloquear a
    // reconfiguração do webhook num pico de tráfego.
    { config: { rateLimit: false } },
    async (request, reply) => {
      const query = request.query as Record<string, string>;
      const mode = query["hub.mode"];
      const token = query["hub.verify_token"];
      const challenge = query["hub.challenge"];

      if (mode === "subscribe" && token === env.META_WEBHOOK_VERIFY_TOKEN) {
        return reply.status(200).send(challenge);
      }

      return reply.status(403).send("Forbidden");
    }
  );

  // 2) Recepção de eventos — regra de ouro: validar, enfileirar, responder rápido.
  app.post(
    "/webhook",
    {
      // Precisamos do corpo cru pra validar a assinatura HMAC antes do parse.
      // Sem rate limit pelo mesmo motivo do GET acima — a assinatura HMAC já
      // filtra requisição forjada, então limitar por IP só arrisca derrubar
      // mensagens reais num pico (broadcast com muita gente respondendo).
      config: { rawBody: true, rateLimit: false },
    },
    async (request, reply) => {
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      const rawBody = (request as any).rawBody as Buffer | undefined;

      if (!isValidSignature(rawBody, signature)) {
        request.log.warn("Webhook com assinatura inválida — descartado");
        // Responder 200 mesmo assim evita que a Meta fique reenviando algo malicioso/malformado.
        return reply.status(200).send("ignored");
      }

      const body = request.body as any;

      // Resposta imediata — TUDO abaixo precisa ser rápido.
      // Nenhuma lógica de negócio aqui, só empurrar pra fila.
      try {
        await webhookQueue.add("process-event", body, {
          jobId: undefined, // dedupe real acontece no worker via whatsappEventKey
        });
      } catch (err) {
        request.log.error({ err }, "Falha ao enfileirar evento de webhook");
        // Mesmo em erro de fila, responder 200 evita retry desnecessário da Meta
        // por um problema que é nosso; o ideal é ter alerta nesse log.
      }

      return reply.status(200).send("EVENT_RECEIVED");
    }
  );
}

function isValidSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
  if (!rawBody || !signatureHeader) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", env.META_APP_SECRET).update(rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

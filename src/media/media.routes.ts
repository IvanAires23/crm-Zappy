import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticateFromHeaderOrQuery } from "../auth/auth.plugin.js";
import { downloadMedia } from "../whatsapp/client.js";

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos";
}

const paramsSchema = z.object({ messageId: z.string().min(1) });

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"] as const;

// Extrai o media id de `content` — mensagem nossa (outbound) guarda
// `{ id, mime_type, ... }` direto; mensagem do cliente (inbound) guarda o
// payload cru da Graph API, com o id dentro de `content[type]`.
function extractMediaId(message: { direction: string; type: string; content: unknown }): string | null {
  const content = message.content as Record<string, unknown> | null;
  if (!content) return null;

  if (message.direction === "outbound") {
    return typeof content.id === "string" ? content.id : null;
  }

  if (!(MEDIA_TYPES as readonly string[]).includes(message.type)) return null;
  const mediaField = content[message.type] as Record<string, unknown> | undefined;
  return typeof mediaField?.id === "string" ? mediaField.id : null;
}

export async function mediaRoutes(app: FastifyInstance) {
  // Proxy autenticado: a Meta hospeda o arquivo de verdade (não guardamos
  // cópia local), mas a URL de download dela é assinada e expira em minutos
  // — então resolvemos ela de novo a cada request em vez de cachear.
  app.get("/media/:messageId", { preHandler: authenticateFromHeaderOrQuery }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }

    const message = await prisma.message.findFirst({
      where: { id: params.data.messageId, tenantId: request.auth.tenantId },
    });
    if (!message) {
      return reply.status(404).send({ error: "Mensagem não encontrada" });
    }

    const mediaId = extractMediaId(message);
    if (!mediaId) {
      return reply.status(404).send({ error: "Essa mensagem não tem mídia associada" });
    }

    try {
      const { buffer, mimeType } = await downloadMedia(request.auth.tenantId, mediaId);
      return reply
        .header("Content-Type", mimeType)
        .header("Cache-Control", "private, max-age=3600")
        .send(buffer);
    } catch (err) {
      request.log.error({ err, mediaId }, "Falha ao baixar mídia da Meta");
      return reply.status(502).send({ error: "Não foi possível carregar a mídia" });
    }
  });
}

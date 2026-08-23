import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rawBody from "fastify-raw-body";
import { env } from "./config/env.js";
import { initSentry, Sentry } from "./config/sentry.js";
import { webhookRoutes } from "./webhook/webhook.routes.js";
import { onboardingRoutes } from "./onboarding/onboarding.routes.js";
import { authRoutes } from "./auth/auth.routes.js";
import { conversationsRoutes } from "./conversations/conversations.routes.js";
import { pipelinesRoutes } from "./pipelines/pipelines.routes.js";
import { dealsRoutes } from "./deals/deals.routes.js";
import { tagsRoutes } from "./tags/tags.routes.js";
import { contactsRoutes } from "./contacts/contacts.routes.js";
import { tasksRoutes } from "./tasks/tasks.routes.js";
import { calendarRoutes } from "./calendar/calendar.routes.js";
import { automationRoutes } from "./automation/automation.routes.js";
import { automationRulesRoutes } from "./automation/rules.routes.js";
import { templatesRoutes } from "./templates/templates.routes.js";
import { broadcastsRoutes } from "./broadcasts/broadcasts.routes.js";
import { customFieldDefinitionsRoutes } from "./customFields/customFieldDefinitions.routes.js";
import { dashboardRoutes } from "./dashboard/dashboard.routes.js";
import { googleCalendarRoutes } from "./integrations/googleCalendar/googleCalendar.routes.js";
import { notesRoutes } from "./notes/notes.routes.js";
import { quickRepliesRoutes } from "./quickReplies/quickReplies.routes.js";
import { mediaRoutes } from "./media/media.routes.js";
import { usersRoutes } from "./users/users.routes.js";
import { setupRealtime } from "./realtime/socket.js";

initSentry();

const app = Fastify({
  logger: {
    transport: { target: "pino-pretty" },
  },
});

// Exceção fora de qualquer handler (ex: erro num setInterval, num listener
// de fila) derrubaria o processo silenciosamente antes disso existir.
process.on("uncaughtException", (err) => {
  Sentry.captureException(err);
  app.log.error(err, "uncaughtException");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  Sentry.captureException(err);
  app.log.error(err, "unhandledRejection");
  process.exit(1);
});

// Captura qualquer erro que escape de uma rota (ex: o Prisma reclamando de
// coluna/tabela ausente) antes de virar só um 500 genérico no log — sem
// isso, um incidente como o de 22/08 só é percebido quando alguém relata.
app.setErrorHandler((error, request, reply) => {
  Sentry.captureException(error, { extra: { url: request.url, method: request.method } });
  request.log.error(error);
  const statusCode = error.statusCode ?? 500;
  reply.status(statusCode).send({
    statusCode,
    error: statusCode === 500 ? "Internal Server Error" : error.name,
    message: error.message,
  });
});

async function main() {
  await app.register(cors, { origin: true });

  // Upload de mídia (imagem/áudio/vídeo/documento) pro envio em conversas —
  // limite de 16MB, o mesmo teto que a própria Meta aplica pra mídia.
  await app.register(multipart, {
    limits: { fileSize: 16 * 1024 * 1024 },
  });

  // Necessário pra validar a assinatura HMAC do webhook com o corpo cru
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });

  await app.register(webhookRoutes);
  await app.register(onboardingRoutes);
  await app.register(authRoutes);
  await app.register(conversationsRoutes);
  await app.register(pipelinesRoutes);
  await app.register(dealsRoutes);
  await app.register(tagsRoutes);
  await app.register(contactsRoutes);
  await app.register(tasksRoutes);
  await app.register(calendarRoutes);
  await app.register(automationRoutes);
  await app.register(automationRulesRoutes);
  await app.register(templatesRoutes);
  await app.register(broadcastsRoutes);
  await app.register(customFieldDefinitionsRoutes);
  await app.register(dashboardRoutes);
  await app.register(googleCalendarRoutes);
  await app.register(notesRoutes);
  await app.register(quickRepliesRoutes);
  await app.register(mediaRoutes);
  await app.register(usersRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  // Anexa o Socket.io no HTTP server cru do Fastify — precisa vir depois
  // do listen() pra app.server já estar de fato escutando na porta.
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  setupRealtime(app.server);
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

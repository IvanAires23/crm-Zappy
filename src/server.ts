import Fastify from "fastify";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import { env } from "./config/env.js";
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

const app = Fastify({
  logger: {
    transport: { target: "pino-pretty" },
  },
});

async function main() {
  await app.register(cors, { origin: true });

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

  app.get("/health", async () => ({ status: "ok" }));

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

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

  app.get("/health", async () => ({ status: "ok" }));

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

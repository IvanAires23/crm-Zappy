import * as Sentry from "@sentry/node";
import { env } from "./env.js";

// Sem SENTRY_DSN configurada, isso não faz nada — captura de erro é
// opcional, nunca bloqueia o boot local nem exige conta pra desenvolver.
export function initSentry() {
  if (!env.SENTRY_DSN) return;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
  });
}

export { Sentry };

import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  JWT_SECRET: z.string().min(10),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_CONFIG_ID: z.string().min(1),
  META_GRAPH_API_VERSION: z.string().default("v21.0"),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1),

  TOKEN_ENCRYPTION_KEY: z.string().min(1),

  // --- Google Calendar (OAuth2) --- opcionais: sem elas, a integração
  // fica desligada (endpoints respondem com erro claro em vez de quebrar o boot).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  FRONTEND_URL: z.string().default("http://localhost:5173"),
  // Origens extras liberadas no CORS além de FRONTEND_URL (separadas por
  // vírgula) — ex: domínio de preview do Vercel. Sem isso, CORS só libera
  // FRONTEND_URL (antes era origin:true, aberto pra qualquer site).
  CORS_ORIGINS: z.string().optional(),

  // Captura de erro em produção — opcional: sem ela, o Sentry simplesmente
  // não é inicializado (ver src/config/sentry.ts).
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default("production"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Variáveis de ambiente inválidas:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { google } from "googleapis";
import { prisma } from "../../db/prisma.js";
import { authenticate } from "../../auth/auth.plugin.js";
import { env } from "../../config/env.js";
import { encryptToken } from "../../config/crypto.js";
import { createGoogleOAuthClient, isGoogleCalendarConfigured, GOOGLE_CALENDAR_SCOPES } from "./googleOAuthClient.js";

interface OAuthState {
  sub: string;
  tenantId: string;
}

export async function googleCalendarRoutes(app: FastifyInstance) {
  // GET /callback é chamado pelo próprio navegador do usuário sendo
  // redirecionado pelo Google — não tem (nem pode ter) Authorization
  // header, então fica de fora do hook de autenticação abaixo.
  app.get("/integrations/google-calendar/callback", async (request, reply) => {
    const { code, state, error } = request.query as { code?: string; state?: string; error?: string };

    if (error || !code || !state) {
      return reply.redirect(`${env.FRONTEND_URL}/configuracoes/calendario?google=error`);
    }

    let payload: OAuthState;
    try {
      payload = jwt.verify(state, env.JWT_SECRET) as OAuthState;
    } catch {
      return reply.redirect(`${env.FRONTEND_URL}/configuracoes/calendario?google=error`);
    }

    try {
      const client = createGoogleOAuthClient();
      const { tokens } = await client.getToken(code);
      if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
        // Sem refresh_token normalmente significa que o usuário já tinha
        // autorizado antes e o Google não reemitiu um novo — teria que
        // revogar o acesso na conta Google e conectar de novo.
        return reply.redirect(`${env.FRONTEND_URL}/configuracoes/calendario?google=error&reason=no_refresh_token`);
      }

      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const userInfo = await oauth2.userinfo.get().catch(() => null);

      await prisma.googleCalendarAccount.upsert({
        where: { userId: payload.sub },
        create: {
          tenantId: payload.tenantId,
          userId: payload.sub,
          googleEmail: userInfo?.data.email ?? null,
          accessTokenEncrypted: encryptToken(tokens.access_token),
          refreshTokenEncrypted: encryptToken(tokens.refresh_token),
          scope: tokens.scope ?? null,
          expiresAt: new Date(tokens.expiry_date),
        },
        update: {
          googleEmail: userInfo?.data.email ?? null,
          accessTokenEncrypted: encryptToken(tokens.access_token),
          refreshTokenEncrypted: encryptToken(tokens.refresh_token),
          scope: tokens.scope ?? null,
          expiresAt: new Date(tokens.expiry_date),
        },
      });

      return reply.redirect(`${env.FRONTEND_URL}/configuracoes/calendario?google=connected`);
    } catch (err) {
      request.log.error({ err }, "Falha ao trocar code por tokens do Google");
      return reply.redirect(`${env.FRONTEND_URL}/configuracoes/calendario?google=error`);
    }
  });

  app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", authenticate);

    protectedApp.get("/integrations/google-calendar/status", async (request, reply) => {
      if (!isGoogleCalendarConfigured()) {
        return reply.send({ configured: false, connected: false });
      }

      const account = await prisma.googleCalendarAccount.findUnique({
        where: { userId: request.auth.sub },
      });

      if (!account) return reply.send({ configured: true, connected: false });

      return reply.send({
        configured: true,
        connected: true,
        email: account.googleEmail,
        calendarId: account.calendarId,
        connectedAt: account.connectedAt,
      });
    });

    protectedApp.get("/integrations/google-calendar/connect", async (request, reply) => {
      if (!isGoogleCalendarConfigured()) {
        return reply.status(400).send({ error: "Integração com Google Calendar não configurada" });
      }

      const state = jwt.sign({ sub: request.auth.sub, tenantId: request.auth.tenantId }, env.JWT_SECRET, {
        expiresIn: "10m",
      });

      const client = createGoogleOAuthClient();
      const url = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent", // força reemissão do refresh_token mesmo se o usuário já tiver autorizado antes
        scope: GOOGLE_CALENDAR_SCOPES,
        state,
      });

      return reply.send({ url });
    });

    protectedApp.delete("/integrations/google-calendar", async (request, reply) => {
      const existing = await prisma.googleCalendarAccount.findUnique({ where: { userId: request.auth.sub } });
      if (!existing) return reply.status(404).send({ error: "Nenhuma conta Google conectada" });

      await prisma.googleCalendarAccount.delete({ where: { userId: request.auth.sub } });
      return reply.status(204).send();
    });
  });
}

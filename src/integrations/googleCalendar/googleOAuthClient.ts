import { google } from "googleapis";
import { env } from "../../config/env.js";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function isGoogleCalendarConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}

// Cria um client novo, sem credenciais — usado pra gerar a URL de consentimento
// e pra trocar o `code` do callback pelos tokens.
export function createGoogleOAuthClient() {
  if (!isGoogleCalendarConfigured()) {
    throw new Error("Integração com Google Calendar não configurada (faltam GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI)");
  }
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
}

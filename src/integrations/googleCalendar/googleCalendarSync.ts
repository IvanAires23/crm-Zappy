import pino from "pino";
import { google, type calendar_v3 } from "googleapis";
import { prisma } from "../../db/prisma.js";
import { decryptToken, encryptToken } from "../../config/crypto.js";
import type { CalendarEvent, GoogleCalendarAccount } from "@prisma/client";

const logger = pino({ transport: { target: "pino-pretty" } });

// Cria um client OAuth2 já autenticado com os tokens salvos da conta, e
// registra um listener que persiste o access token renovado — a lib do
// Google já renova sozinha antes de cada chamada quando o token expirou.
function authorizedClientFor(account: GoogleCalendarAccount) {
  const client = new google.auth.OAuth2();
  client.setCredentials({
    access_token: decryptToken(account.accessTokenEncrypted),
    refresh_token: decryptToken(account.refreshTokenEncrypted),
    expiry_date: account.expiresAt.getTime(),
  });

  client.on("tokens", (tokens) => {
    if (!tokens.access_token) return;
    prisma.googleCalendarAccount
      .update({
        where: { id: account.id },
        data: {
          accessTokenEncrypted: encryptToken(tokens.access_token),
          ...(tokens.refresh_token ? { refreshTokenEncrypted: encryptToken(tokens.refresh_token) } : {}),
          ...(tokens.expiry_date ? { expiresAt: new Date(tokens.expiry_date) } : {}),
        },
      })
      .catch((err) => logger.error({ err, accountId: account.id }, "Falha ao salvar token renovado do Google"));
  });

  return client;
}

async function getAccountForAssignedUser(assignedUserId: string | null): Promise<GoogleCalendarAccount | null> {
  if (!assignedUserId) return null;
  return prisma.googleCalendarAccount.findUnique({ where: { userId: assignedUserId } });
}

function toGoogleEventBody(event: CalendarEvent): calendar_v3.Schema$Event {
  return {
    summary: event.title,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    start: event.allDay
      ? { date: event.startAt.toISOString().slice(0, 10) }
      : { dateTime: event.startAt.toISOString() },
    end: event.allDay ? { date: event.endAt.toISOString().slice(0, 10) } : { dateTime: event.endAt.toISOString() },
    status: event.status === "canceled" ? "cancelled" : "confirmed",
  };
}

// Best-effort: nunca lança — se o usuário não conectou o Google, ou a
// chamada falha (token revogado, rate limit etc.), só loga e segue. Um
// evento de calendário do CRM não pode deixar de ser salvo por causa do
// Google estar fora do ar.
export async function syncCalendarEventToGoogle(eventId: string): Promise<void> {
  const event = await prisma.calendarEvent.findUnique({ where: { id: eventId } });
  if (!event) return;

  const account = await getAccountForAssignedUser(event.assignedUserId);
  if (!account) return;

  try {
    const auth = authorizedClientFor(account);
    const calendar = google.calendar({ version: "v3", auth });
    const requestBody = toGoogleEventBody(event);

    if (event.status === "canceled" && !event.googleEventId) {
      // nunca chegou a existir no Google, não há o que cancelar
      return;
    }

    let googleEventId = event.googleEventId;
    if (googleEventId) {
      await calendar.events.update({ calendarId: account.calendarId, eventId: googleEventId, requestBody });
    } else {
      const created = await calendar.events.insert({ calendarId: account.calendarId, requestBody });
      googleEventId = created.data.id ?? null;
    }

    await prisma.calendarEvent.update({
      where: { id: event.id },
      data: { googleEventId, googleSyncedAt: new Date() },
    });
  } catch (err) {
    logger.error({ err, calendarEventId: event.id, userId: account.userId }, "Falha ao sincronizar evento com o Google Calendar");
  }
}

export async function deleteGoogleEventForCalendarEvent(event: CalendarEvent): Promise<void> {
  if (!event.googleEventId) return;

  const account = await getAccountForAssignedUser(event.assignedUserId);
  if (!account) return;

  try {
    const auth = authorizedClientFor(account);
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.events.delete({ calendarId: account.calendarId, eventId: event.googleEventId });
  } catch (err) {
    logger.error({ err, calendarEventId: event.id }, "Falha ao excluir evento no Google Calendar");
  }
}

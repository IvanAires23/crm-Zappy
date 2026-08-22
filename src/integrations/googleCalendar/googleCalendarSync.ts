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

// Só busca eventos futuros num horizonte razoável — não faz sentido puxar
// anos de histórico pro CRM, e evita um primeiro sync gigante.
const PULL_HORIZON_MS = 180 * 24 * 60 * 60 * 1000;

function isGoogleApiError(err: unknown, code: number): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

// Espelha um evento vindo do Google numa linha local de CalendarEvent,
// casando pelo par (assignedUserId, googleEventId). Eventos que já
// pertencem a uma Task nunca têm o conteúdo sobrescrito por aqui — o CRM
// é quem manda neles; só atualizamos o carimbo de sincronização.
async function upsertLocalEventFromGoogle(account: GoogleCalendarAccount, event: calendar_v3.Schema$Event) {
  if (!event.id) return;

  const existing = await prisma.calendarEvent.findUnique({
    where: { assignedUserId_googleEventId: { assignedUserId: account.userId, googleEventId: event.id } },
  });

  if (existing?.taskId) {
    await prisma.calendarEvent.update({ where: { id: existing.id }, data: { googleSyncedAt: new Date() } });
    return;
  }

  if (event.status === "cancelled") {
    if (existing) await prisma.calendarEvent.delete({ where: { id: existing.id } });
    return;
  }

  const startAt = event.start?.dateTime ?? event.start?.date;
  const endAt = event.end?.dateTime ?? event.end?.date;
  if (!startAt || !endAt) return; // evento recorrente "mestre" sem data própria, ou corrompido — ignora

  const fields = {
    tenantId: account.tenantId,
    title: event.summary ?? "(sem título)",
    description: event.description ?? null,
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    allDay: Boolean(event.start?.date && !event.start?.dateTime),
    location: event.location ?? null,
    assignedUserId: account.userId,
    status: "scheduled" as const, // Google não distingue "concluído" — só cancelado (tratado acima)
    googleEventId: event.id,
    googleSyncedAt: new Date(),
  };

  if (existing) {
    await prisma.calendarEvent.update({ where: { id: existing.id }, data: fields });
  } else {
    await prisma.calendarEvent.create({ data: fields });
  }
}

// Importa (e mantém atualizados) os eventos do Google Calendar da conta
// conectada pra dentro do CRM — a outra metade da sincronização de mão
// dupla (a primeira metade é o syncCalendarEventToGoogle acima). Usa o
// syncToken da Google Calendar API pra só buscar o que mudou depois da
// primeira vez. Best-effort, como o resto desse módulo.
export async function pullGoogleEventsForAccount(account: GoogleCalendarAccount): Promise<void> {
  try {
    const auth = authorizedClientFor(account);
    const calendar = google.calendar({ version: "v3", auth });

    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;

    do {
      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId: account.calendarId,
        singleEvents: true,
        maxResults: 250,
        pageToken,
      };
      if (account.googleSyncToken) {
        params.syncToken = account.googleSyncToken;
      } else {
        params.timeMin = new Date().toISOString();
        params.timeMax = new Date(Date.now() + PULL_HORIZON_MS).toISOString();
      }

      const res = await calendar.events.list(params);

      for (const event of res.data.items ?? []) {
        await upsertLocalEventFromGoogle(account, event);
      }

      pageToken = res.data.nextPageToken ?? undefined;
      if (res.data.nextSyncToken) nextSyncToken = res.data.nextSyncToken;
    } while (pageToken);

    await prisma.googleCalendarAccount.update({
      where: { id: account.id },
      data: { googleSyncToken: nextSyncToken ?? account.googleSyncToken, lastGoogleSyncAt: new Date() },
    });
  } catch (err) {
    if (isGoogleApiError(err, 410)) {
      // syncToken expirado/inválido — limpa pra próxima rodada refazer o full sync
      await prisma.googleCalendarAccount.update({ where: { id: account.id }, data: { googleSyncToken: null } });
      return;
    }
    logger.error({ err, accountId: account.id }, "Falha ao importar eventos do Google Calendar");
  }
}

export async function pullAllConnectedGoogleCalendars(): Promise<void> {
  const accounts = await prisma.googleCalendarAccount.findMany();
  for (const account of accounts) {
    await pullGoogleEventsForAccount(account);
  }
}

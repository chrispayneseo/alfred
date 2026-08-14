import { calendar_v3 } from "googleapis";
import type { Env } from "../db.js";
import { createAuthenticatedClient } from "./client.js";
import { markAccountNeedsReconnect, markAccountOk, type GoogleAccountEnv } from "./accounts.js";
import { GoogleNotConnectedError, GoogleReconnectRequiredError, isGoogleAuthError } from "./errors.js";

export interface CalendarEventRecord {
  id: string;
  title: string;
  /** ISO datetime, or "yyyy-mm-dd" for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** Which connected account this event came from — Step 8 (multi-account). */
  accountEmail: string;
}

export interface DateRange {
  start: Date;
  end: Date;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function getTodayRange(): DateRange {
  const start = startOfDay(new Date());
  return { start, end: addDays(start, 1) };
}

export function getTomorrowRange(): DateRange {
  const start = addDays(startOfDay(new Date()), 1);
  return { start, end: addDays(start, 1) };
}

function mapEvent(event: calendar_v3.Schema$Event, accountEmail: string): CalendarEventRecord | undefined {
  if (!event.id || event.status === "cancelled") return undefined;
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;
  if (!start || !end) return undefined;

  return {
    id: event.id,
    title: event.summary?.trim() || "(untitled event)",
    start,
    end,
    allDay: !event.start?.dateTime,
    location: event.location ?? undefined,
    accountEmail,
  };
}

/**
 * Lists events on one account's primary calendar between two dates (inclusive
 * start, exclusive end). Everything else in this file is either a
 * convenience wrapper around this for a single account, or a multi-account
 * merge built on top of it.
 */
export async function listEvents(env: GoogleAccountEnv, range: DateRange): Promise<CalendarEventRecord[]> {
  if (!env.refreshToken) throw new GoogleNotConnectedError();

  const auth = createAuthenticatedClient(env);
  const calendar = new calendar_v3.Calendar({ auth });

  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: range.start.toISOString(),
      timeMax: range.end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    return (res.data.items ?? []).map((e) => mapEvent(e, env.email)).filter((e): e is CalendarEventRecord => e !== undefined);
  } catch (error) {
    if (isGoogleAuthError(error)) throw new GoogleReconnectRequiredError(error);
    throw error;
  }
}

export interface NewEventInput {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24h — omit for an all-day event. */
  startTime?: string;
  /** HH:MM — defaults to startTime + 1 hour when a timed event omits it. */
  endTime?: string;
  location?: string;
}

// No per-user timezone setting exists anywhere in this app (a single-user
// personal app, and every other date-handling feature already assumes the
// user's own local time implicitly) — hardcoded here rather than adding
// preference infrastructure for a feature that doesn't otherwise need one.
// Passed as an explicit IANA zone alongside a floating (no-offset) dateTime
// so Google resolves DST correctly — safer than doing UTC math by hand,
// which would silently be an hour off in summer if this ever ran somewhere
// that defaults to UTC (e.g. a serverless function).
export const DEFAULT_TIME_ZONE = "Europe/London";

function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addOneHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m + 60) % (24 * 60);
  return `${Math.floor(total / 60).toString().padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}

/** Creates a single event on one account's primary calendar. Always called
 * from a route that requires the user's explicit confirmation first
 * (server/handleApiRequest.ts's /api/calendar/create-event) — this function
 * itself has no confirmation step, so it must never be called directly from
 * anything that hasn't already gotten a yes from the user. */
export async function createEvent(env: GoogleAccountEnv, input: NewEventInput): Promise<CalendarEventRecord> {
  if (!env.refreshToken) throw new GoogleNotConnectedError();

  const auth = createAuthenticatedClient(env);
  const calendar = new calendar_v3.Calendar({ auth });

  const requestBody: calendar_v3.Schema$Event = input.startTime
    ? {
        summary: input.title,
        location: input.location,
        start: { dateTime: `${input.date}T${input.startTime}:00`, timeZone: DEFAULT_TIME_ZONE },
        end: { dateTime: `${input.date}T${input.endTime ?? addOneHour(input.startTime)}:00`, timeZone: DEFAULT_TIME_ZONE },
      }
    : {
        summary: input.title,
        location: input.location,
        start: { date: input.date },
        end: { date: addOneDay(input.date) },
      };

  try {
    const res = await calendar.events.insert({ calendarId: "primary", requestBody });
    const mapped = mapEvent(res.data, env.email);
    if (!mapped) throw new Error("Google returned an event that couldn't be parsed");
    return mapped;
  } catch (error) {
    if (isGoogleAuthError(error)) throw new GoogleReconnectRequiredError(error);
    throw error;
  }
}

export function getTodayEvents(env: GoogleAccountEnv): Promise<CalendarEventRecord[]> {
  return listEvents(env, getTodayRange());
}

export function getTomorrowEvents(env: GoogleAccountEnv): Promise<CalendarEventRecord[]> {
  return listEvents(env, getTomorrowRange());
}

export interface MultiAccountEvents {
  events: CalendarEventRecord[];
  /** Emails of connected accounts that need reconnecting — the merged
   * `events` above still include everything from the accounts that worked. */
  failedAccounts: string[];
}

/** Merges events across every connected account, sorted by start time. If a
 * specific account's token needs reconnecting, its events are simply left
 * out (and it's reported in failedAccounts) rather than failing the whole
 * request — so one stale token doesn't take down a still-working account.
 * Only throws GoogleReconnectRequiredError if EVERY connected account fails,
 * matching the single-account "reconnect" screen when nothing works at all. */
export async function listEventsAllAccounts(env: Env, accounts: GoogleAccountEnv[], range: DateRange): Promise<MultiAccountEvents> {
  if (accounts.length === 0) throw new GoogleNotConnectedError();

  const failedAccounts: string[] = [];
  const perAccount = await Promise.all(
    accounts.map(async (account) => {
      try {
        const events = await listEvents(account, range);
        await markAccountOk(env, account.email);
        return events;
      } catch (error) {
        if (error instanceof GoogleReconnectRequiredError) {
          await markAccountNeedsReconnect(env, account.email);
          failedAccounts.push(account.email);
          return [];
        }
        throw error;
      }
    })
  );

  if (failedAccounts.length === accounts.length) throw new GoogleReconnectRequiredError();

  const events = perAccount.flat().sort((a, b) => a.start.localeCompare(b.start));
  return { events, failedAccounts };
}

export function getTodayEventsAllAccounts(env: Env, accounts: GoogleAccountEnv[]): Promise<MultiAccountEvents> {
  return listEventsAllAccounts(env, accounts, getTodayRange());
}

export function getTomorrowEventsAllAccounts(env: Env, accounts: GoogleAccountEnv[]): Promise<MultiAccountEvents> {
  return listEventsAllAccounts(env, accounts, getTomorrowRange());
}

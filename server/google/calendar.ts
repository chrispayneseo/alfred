import { calendar_v3 } from "googleapis";
import { createAuthenticatedClient } from "./client";
import type { GoogleEnv } from "./env";
import { GoogleNotConnectedError, GoogleReconnectRequiredError } from "./errors";

export interface CalendarEventRecord {
  id: string;
  title: string;
  /** ISO datetime, or "yyyy-mm-dd" for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
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

function mapEvent(event: calendar_v3.Schema$Event): CalendarEventRecord | undefined {
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
  };
}

function isAuthError(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { error?: string } } }).response;
  if (!response) return false;
  return response.status === 401 || response.status === 400 || response.data?.error === "invalid_grant";
}

/**
 * Lists events on the primary calendar between two dates (inclusive start,
 * exclusive end). This is the one entry point later steps — cross-referencing
 * calendar with email and Notion — should call; everything else in this file
 * is a convenience wrapper around it.
 */
export async function listEvents(env: GoogleEnv, range: DateRange): Promise<CalendarEventRecord[]> {
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
    return (res.data.items ?? []).map(mapEvent).filter((e): e is CalendarEventRecord => e !== undefined);
  } catch (error) {
    if (isAuthError(error)) throw new GoogleReconnectRequiredError(error);
    throw error;
  }
}

export function getTodayEvents(env: GoogleEnv): Promise<CalendarEventRecord[]> {
  return listEvents(env, getTodayRange());
}

export function getTomorrowEvents(env: GoogleEnv): Promise<CalendarEventRecord[]> {
  return listEvents(env, getTomorrowRange());
}

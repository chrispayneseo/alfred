export interface CalendarApiEvent {
  id: string;
  title: string;
  /** ISO datetime, or "yyyy-mm-dd" for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** Which connected Google account this event is from (Step 8). */
  accountEmail: string;
}

export interface MultiAccountEvents {
  events: CalendarApiEvent[];
  /** Emails of connected accounts whose events couldn't be included this
   * time (needs reconnecting) — the events above are still from whichever
   * accounts did work. */
  failedAccounts: string[];
}

export interface CalendarStatus {
  connected: boolean;
}

async function fetchEvents(path: string): Promise<MultiAccountEvents> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.error === "not_connected" || body.error === "reconnect_required") {
      throw new Error(body.error);
    }
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return res.json();
}

export function fetchTodayEvents(): Promise<MultiAccountEvents> {
  return fetchEvents("/api/calendar/today");
}

export function fetchTomorrowEvents(): Promise<MultiAccountEvents> {
  return fetchEvents("/api/calendar/tomorrow");
}

export async function fetchCalendarStatus(): Promise<CalendarStatus> {
  const res = await fetch("/api/google/status");
  if (!res.ok) return { connected: false };
  return res.json();
}

export interface CreateEventInput {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  account: string;
}

/** Always called after the user has explicitly confirmed a proposal Chat
 * showed them — never call this from anything the user hasn't approved. */
export async function createCalendarEvent(input: CreateEventInput): Promise<CalendarApiEvent> {
  const res = await fetch("/api/calendar/create-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.error === "not_connected" || body.error === "reconnect_required") throw new Error(body.error);
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return res.json();
}

export interface CalendarApiEvent {
  id: string;
  title: string;
  /** ISO datetime, or "yyyy-mm-dd" for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
}

export interface CalendarStatus {
  connected: boolean;
}

async function fetchEvents(path: string): Promise<CalendarApiEvent[]> {
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

export function fetchTodayEvents(): Promise<CalendarApiEvent[]> {
  return fetchEvents("/api/calendar/today");
}

export function fetchTomorrowEvents(): Promise<CalendarApiEvent[]> {
  return fetchEvents("/api/calendar/tomorrow");
}

export async function fetchCalendarStatus(): Promise<CalendarStatus> {
  const res = await fetch("/api/google/status");
  if (!res.ok) return { connected: false };
  return res.json();
}

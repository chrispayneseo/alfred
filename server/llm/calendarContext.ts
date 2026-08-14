import type { GoogleEnv } from "../google/env";
import { getTodayEvents, getTomorrowEvents, type CalendarEventRecord } from "../google/calendar";
import { GoogleNotConnectedError, GoogleReconnectRequiredError } from "../google/errors";

const CALENDAR_KEYWORDS = [
  "calendar",
  "meeting",
  "meetings",
  "event",
  "events",
  "schedule",
  "today",
  "tomorrow",
  "appointment",
  "appointments",
  "agenda",
  "busy",
  "free time",
  "plans",
];

/** Keyword heuristic — mirrors the model router's approach (Step 3): cheap and
 * predictable rather than asking a model to decide if it needs calendar data. */
export function needsCalendarContext(text: string): boolean {
  const lower = text.toLowerCase();
  return CALENDAR_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function formatEvent(event: CalendarEventRecord): string {
  if (event.allDay) return `- ${event.title} (all day)`;
  const start = new Date(event.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const end = new Date(event.end).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const location = event.location ? ` — ${event.location}` : "";
  return `- ${start}–${end}: ${event.title}${location}`;
}

/** Fetches real calendar data and formats it for the model's system context.
 * Never throws — a connection problem becomes an honest note in the context
 * instead of failing the whole chat request. */
export async function buildCalendarContext(env: GoogleEnv): Promise<string> {
  try {
    const [today, tomorrow] = await Promise.all([getTodayEvents(env), getTomorrowEvents(env)]);
    const todayBlock = today.length ? today.map(formatEvent).join("\n") : "No events today.";
    const tomorrowBlock = tomorrow.length ? tomorrow.map(formatEvent).join("\n") : "No events tomorrow.";
    return `Here is the user's real Google Calendar data. Use it to answer precisely — do not guess or estimate.\n\nToday:\n${todayBlock}\n\nTomorrow:\n${tomorrowBlock}`;
  } catch (error) {
    if (error instanceof GoogleNotConnectedError) {
      return "The user's Google Calendar isn't connected yet. If they ask about their schedule, tell them to connect it from the Today screen — don't guess at their calendar.";
    }
    if (error instanceof GoogleReconnectRequiredError) {
      return "The user's Google Calendar connection has expired and needs reconnecting. If they ask about their schedule, tell them so — don't guess at their calendar.";
    }
    console.error("[calendarContext] failed to fetch calendar data:", error);
    return "Calendar data couldn't be fetched right now due to an error. If asked about their schedule, say so rather than guessing.";
  }
}

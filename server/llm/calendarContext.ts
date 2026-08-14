import type { GoogleAccountEnv } from "../google/accounts";
import { getTodayEventsAllAccounts, getTomorrowEventsAllAccounts, type CalendarEventRecord } from "../google/calendar";
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
  const account = ` [${event.accountEmail}]`;
  if (event.allDay) return `- ${event.title} (all day)${account}`;
  const start = new Date(event.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const end = new Date(event.end).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const location = event.location ? ` — ${event.location}` : "";
  return `- ${start}–${end}: ${event.title}${location}${account}`;
}

/** Fetches real calendar data across every connected account and formats it
 * for the model's system context. Never throws — a connection problem
 * becomes an honest note in the context instead of failing the whole chat
 * request. If one account needs reconnecting but another still works, the
 * working account's events are still included, with an honest note about
 * the one that's missing (Step 8: multi-account). */
export async function buildCalendarContext(accounts: GoogleAccountEnv[]): Promise<string> {
  try {
    const [today, tomorrow] = await Promise.all([getTodayEventsAllAccounts(accounts), getTomorrowEventsAllAccounts(accounts)]);
    const todayBlock = today.events.length ? today.events.map(formatEvent).join("\n") : "No events today.";
    const tomorrowBlock = tomorrow.events.length ? tomorrow.events.map(formatEvent).join("\n") : "No events tomorrow.";
    const failedAccounts = [...new Set([...today.failedAccounts, ...tomorrow.failedAccounts])];
    const failedNote = failedAccounts.length
      ? `\n\nNote: the calendar for ${failedAccounts.join(", ")} couldn't be checked (needs reconnecting) — the events above are from the user's other connected account(s) only.`
      : "";

    return `Here is the user's real Google Calendar data across all their connected accounts (each event tagged with which account it's from). Use it to answer precisely — do not guess or estimate.\n\nToday:\n${todayBlock}\n\nTomorrow:\n${tomorrowBlock}${failedNote}`;
  } catch (error) {
    if (error instanceof GoogleNotConnectedError) {
      return "The user's Google Calendar isn't connected yet. If they ask about their schedule, tell them to connect it from the Today screen — don't guess at their calendar.";
    }
    if (error instanceof GoogleReconnectRequiredError) {
      return "The user's Google Calendar connection(s) have expired and need reconnecting. If they ask about their schedule, tell them so — don't guess at their calendar.";
    }
    console.error("[calendarContext] failed to fetch calendar data:", error);
    return "Calendar data couldn't be fetched right now due to an error. If asked about their schedule, say so rather than guessing.";
  }
}

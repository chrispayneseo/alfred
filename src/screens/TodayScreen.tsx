import { useEffect, useState } from "react";
import { GmailFlagged } from "../components/GmailFlagged";
import { Nudges } from "../components/Nudges";
import { Screen } from "../components/Screen";
import { fetchTodayEvents, fetchTomorrowEvents, type CalendarApiEvent } from "../integrations/google-calendar/api";
import { mockNotes, mockTasks } from "../mocks/today";

type CalendarState = "loading" | "ok" | "not_connected" | "reconnect_required" | "error";

function formatDate() {
  return new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function formatEventTime(event: CalendarApiEvent): string {
  if (event.allDay) return "All day";
  return new Date(event.start).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

const OAUTH_NOTICE: Record<string, string> = {
  connected: "Google Calendar connected.",
  denied: "Calendar connection was cancelled.",
  error: "Something went wrong connecting your calendar — try again.",
};

function EventList({ events }: { events: CalendarApiEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing scheduled.</p>;
  }
  return (
    <ul className="space-y-3">
      {events.map((event) => (
        <li key={event.id} className="flex items-baseline gap-3">
          <span className="w-14 shrink-0 text-xs tabular-nums text-ink-soft dark:text-ink-soft-dark">
            {formatEventTime(event)}
          </span>
          <div>
            <p className="text-sm text-ink dark:text-ink-dark">{event.title}</p>
            {event.location && <p className="text-xs text-ink-faint dark:text-ink-faint-dark">{event.location}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function TodayScreen() {
  const openTasks = mockTasks.filter((task) => !task.done);
  const [calendarState, setCalendarState] = useState<CalendarState>("loading");
  const [todayEvents, setTodayEvents] = useState<CalendarApiEvent[]>([]);
  const [tomorrowEvents, setTomorrowEvents] = useState<CalendarApiEvent[]>([]);
  const [oauthNotice, setOauthNotice] = useState<string>();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const calendarParam = params.get("calendar");
    if (calendarParam && OAUTH_NOTICE[calendarParam]) {
      setOauthNotice(OAUTH_NOTICE[calendarParam]);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchTodayEvents(), fetchTomorrowEvents()])
      .then(([today, tomorrow]) => {
        setTodayEvents(today);
        setTomorrowEvents(tomorrow);
        setCalendarState("ok");
      })
      .catch((error) => {
        if (error instanceof Error && (error.message === "not_connected" || error.message === "reconnect_required")) {
          setCalendarState(error.message);
        } else {
          setCalendarState("error");
        }
      });
  }, [oauthNotice]);

  return (
    <Screen title="Today" subtitle={formatDate()}>
      {oauthNotice && (
        <p className="mb-4 rounded-xl bg-paper-raised px-3 py-2 text-xs text-ink-soft dark:bg-paper-raised-dark dark:text-ink-soft-dark">
          {oauthNotice}
        </p>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Schedule
        </h2>

        {calendarState === "loading" && (
          <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading your schedule…</p>
        )}

        {(calendarState === "not_connected" || calendarState === "reconnect_required") && (
          <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
            <p className="mb-2 text-sm text-ink-soft dark:text-ink-soft-dark">
              {calendarState === "not_connected"
                ? "Connect Google Calendar to see your schedule here."
                : "Your calendar connection needs to be refreshed."}
            </p>
            <a
              href="/api/google/auth/start"
              className="inline-block rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-paper dark:bg-ink-dark dark:text-paper-dark"
            >
              {calendarState === "not_connected" ? "Connect calendar" : "Reconnect calendar"}
            </a>
          </div>
        )}

        {calendarState === "error" && (
          <p className="text-sm text-claude">Couldn't load your calendar right now. Try again shortly.</p>
        )}

        {calendarState === "ok" && (
          <>
            <EventList events={todayEvents} />
            <div className="mt-5">
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint/80 dark:text-ink-faint-dark/80">
                Tomorrow
              </h3>
              <EventList events={tomorrowEvents} />
            </div>
          </>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Nudges
        </h2>
        <Nudges />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Flagged
        </h2>
        <GmailFlagged />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Open tasks
        </h2>
        <ul className="space-y-2.5">
          {openTasks.map((task) => (
            <li key={task.id} className="flex items-start gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint dark:bg-ink-faint-dark" />
              <div>
                <p className="text-sm text-ink dark:text-ink-dark">{task.title}</p>
                <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
                  {task.due}
                  {task.project ? ` · ${task.project}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Recent notes
        </h2>
        <ul className="space-y-3">
          {mockNotes.map((note) => (
            <li key={note.id}>
              <p className="text-sm text-ink dark:text-ink-dark">{note.title}</p>
              <p className="truncate text-xs text-ink-faint dark:text-ink-faint-dark">{note.excerpt}</p>
            </li>
          ))}
        </ul>
      </section>
    </Screen>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AccountTag } from "../components/AccountTag";
import { CoachPlanTeaser } from "../components/CoachPlanTeaser";
import { GmailFlagged } from "../components/GmailFlagged";
import { Nudges } from "../components/Nudges";
import { ProjectGroupingSuggestions } from "../components/ProjectGroupingSuggestions";
import { RecurringSuggestions } from "../components/RecurringSuggestions";
import { Screen } from "../components/Screen";
import { WeatherSummary } from "../components/WeatherSummary";
import { WeeklyDigestTeaser } from "../components/WeeklyDigestTeaser";
import { fetchTodayEvents, fetchTomorrowEvents, type CalendarApiEvent } from "../integrations/google-calendar/api";
import { fetchGoogleAccounts, type GoogleAccount } from "../integrations/google-accounts/api";
import { buildAccountColorMap } from "../lib/accountColor";
import { mockNotes } from "../mocks/today";
import { deleteTask, fetchTasks, updateTaskStatus, type ApiTask } from "../integrations/notion/api";

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

function EventList({
  events,
  colorMap,
  showAccountTags,
}: {
  events: CalendarApiEvent[];
  colorMap: ReturnType<typeof buildAccountColorMap>;
  showAccountTags: boolean;
}) {
  if (events.length === 0) {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing scheduled.</p>;
  }
  const now = Date.now();

  return (
    <ul className="space-y-3">
      {events.map((event) => {
        const isPast = !event.allDay && new Date(event.end).getTime() < now;
        return (
          <li key={`${event.accountEmail}:${event.id}`} className={`flex items-baseline gap-3 ${isPast ? "opacity-40" : ""}`}>
            <span className="w-14 shrink-0 text-xs tabular-nums text-ink-soft dark:text-ink-soft-dark">
              {formatEventTime(event)}
            </span>
            <div>
              <p className="text-sm text-ink dark:text-ink-dark">{event.title}</p>
              <div className="flex items-center gap-2">
                {event.location && <p className="text-xs text-ink-faint dark:text-ink-faint-dark">{event.location}</p>}
                {showAccountTags && (
                  <AccountTag email={event.accountEmail} color={colorMap.get(event.accountEmail) ?? "a"} />
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function TodayScreen() {
  const [calendarState, setCalendarState] = useState<CalendarState>("loading");
  const [todayEvents, setTodayEvents] = useState<CalendarApiEvent[]>([]);
  const [tomorrowEvents, setTomorrowEvents] = useState<CalendarApiEvent[]>([]);
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [failedAccounts, setFailedAccounts] = useState<string[]>([]);
  const [oauthNotice, setOauthNotice] = useState<string>();
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string>();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const calendarParam = params.get("calendar");
    if (calendarParam && OAUTH_NOTICE[calendarParam]) {
      setOauthNotice(OAUTH_NOTICE[calendarParam]);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchTodayEvents(), fetchTomorrowEvents(), fetchGoogleAccounts()])
      .then(([today, tomorrow, accts]) => {
        setTodayEvents(today.events);
        setTomorrowEvents(tomorrow.events);
        setFailedAccounts([...new Set([...today.failedAccounts, ...tomorrow.failedAccounts])]);
        setAccounts(accts);
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

  useEffect(() => {
    fetchTasks()
      .then(setTasks)
      .catch((err) => setTasksError(err instanceof Error ? err.message : "Couldn't load tasks."))
      .finally(() => setTasksLoading(false));
  }, []);

  async function toggleTask(task: ApiTask) {
    const done = !task.done;
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done } : t)));
    try {
      await updateTaskStatus(task.id, done);
    } catch {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done: !done } : t)));
    }
  }

  async function removeTask(task: ApiTask) {
    const prev = tasks;
    setTasks((p) => p.filter((t) => t.id !== task.id));
    try {
      await deleteTask(task.id);
    } catch {
      setTasks(prev);
    }
  }

  const openTasks = tasks.filter((task) => !task.done);
  const accountColorMap = buildAccountColorMap(accounts);
  const showAccountTags = accounts.length > 1;

  return (
    <Screen
      title="Today"
      subtitle={formatDate()}
      headerAction={
        <Link
          to="/settings"
          aria-label="Settings"
          className="mt-1 rounded-full p-1.5 text-ink-faint hover:text-ink dark:text-ink-faint-dark dark:hover:text-ink-dark"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75">
            <circle cx="12" cy="12" r="3" />
            <path
              strokeLinecap="round"
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
            />
          </svg>
        </Link>
      }
    >
      {oauthNotice && (
        <p className="mb-4 rounded-xl bg-paper-raised px-3 py-2 text-xs text-ink-soft dark:bg-paper-raised-dark dark:text-ink-soft-dark">
          {oauthNotice}
        </p>
      )}

      <WeatherSummary />

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
            <EventList events={todayEvents} colorMap={accountColorMap} showAccountTags={showAccountTags} />
            <div className="mt-5">
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint/80 dark:text-ink-faint-dark/80">
                Tomorrow
              </h3>
              <EventList events={tomorrowEvents} colorMap={accountColorMap} showAccountTags={showAccountTags} />
            </div>
            {failedAccounts.length > 0 && (
              <p className="mt-4 text-xs text-ink-faint dark:text-ink-faint-dark">
                {failedAccounts.join(", ")} needs reconnecting —{" "}
                <Link to="/settings" className="underline">
                  see Settings
                </Link>
                .
              </p>
            )}
          </>
        )}
      </section>

      <WeeklyDigestTeaser />

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Nudges
        </h2>
        <Nudges />
      </section>

      <RecurringSuggestions />

      <ProjectGroupingSuggestions />

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
        {tasksLoading && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading tasks…</p>}
        {tasksError && <p className="text-sm text-claude">{tasksError}</p>}
        {!tasksLoading && !tasksError && (
          <ul className="space-y-2.5">
            {openTasks.length === 0 && (
              <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing open.</p>
            )}
            {openTasks.map((task) => (
              <li key={task.id} className="flex items-start gap-3">
                <button
                  onClick={() => toggleTask(task)}
                  aria-label="Mark as done"
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-ink-faint transition-colors hover:border-ink hover:text-ink dark:border-line-dark dark:text-ink-faint-dark dark:hover:border-ink-dark dark:hover:text-ink-dark"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink dark:text-ink-dark">{task.title}</p>
                  <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
                    {task.due ?? "No due date"}
                    {task.projectName ? ` · ${task.projectName}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => removeTask(task)}
                  aria-label="Remove task"
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:text-claude dark:text-ink-faint-dark/60"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CoachPlanTeaser />

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

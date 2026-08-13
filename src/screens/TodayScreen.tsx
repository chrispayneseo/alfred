import { Screen } from "../components/Screen";
import { mockEvents, mockNotes, mockTasks } from "../mocks/today";

function formatDate() {
  return new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function TodayScreen() {
  const openTasks = mockTasks.filter((task) => !task.done);

  return (
    <Screen title="Today" subtitle={formatDate()}>
      <section className="mb-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
          Schedule
        </h2>
        <ul className="space-y-3">
          {mockEvents.map((event) => (
            <li key={event.id} className="flex items-baseline gap-3">
              <span className="w-14 shrink-0 text-xs tabular-nums text-ink-soft dark:text-ink-soft-dark">
                {event.start}
              </span>
              <div>
                <p className="text-sm text-ink dark:text-ink-dark">{event.title}</p>
                {event.location && (
                  <p className="text-xs text-ink-faint dark:text-ink-faint-dark">{event.location}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
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

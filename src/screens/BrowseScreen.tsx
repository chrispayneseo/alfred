import { useState } from "react";
import { Screen } from "../components/Screen";
import { browseNotes, browseProjects, browseTasks } from "../mocks/browse";

const tabs = ["Tasks", "Notes", "Projects"] as const;
type Tab = (typeof tabs)[number];

const statusLabel: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
};

export function BrowseScreen() {
  const [tab, setTab] = useState<Tab>("Tasks");

  return (
    <Screen title="Browse" subtitle="A window into your Notion workspace">
      <div className="mb-6 flex gap-1 rounded-full border border-line p-1 dark:border-line-dark">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-full py-1.5 text-xs font-medium transition-colors ${
              tab === t
                ? "bg-ink text-paper dark:bg-ink-dark dark:text-paper-dark"
                : "text-ink-soft dark:text-ink-soft-dark"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Tasks" && (
        <ul className="space-y-2.5">
          {browseTasks.map((task) => (
            <li key={task.id} className="flex items-start gap-3">
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  task.done ? "bg-ink-faint/50 dark:bg-ink-faint-dark/50" : "bg-ink-faint dark:bg-ink-faint-dark"
                }`}
              />
              <div>
                <p className={`text-sm text-ink dark:text-ink-dark ${task.done ? "line-through opacity-50" : ""}`}>
                  {task.title}
                </p>
                <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
                  {task.due ?? "No due date"}
                  {task.project ? ` · ${task.project}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === "Notes" && (
        <ul className="space-y-4">
          {browseNotes.map((note) => (
            <li key={note.id}>
              <p className="text-sm text-ink dark:text-ink-dark">{note.title}</p>
              <p className="truncate text-xs text-ink-faint dark:text-ink-faint-dark">{note.excerpt}</p>
              <p className="mt-0.5 text-[11px] text-ink-faint/80 dark:text-ink-faint-dark/80">{note.updatedAt}</p>
            </li>
          ))}
        </ul>
      )}

      {tab === "Projects" && (
        <ul className="space-y-3">
          {browseProjects.map((project) => (
            <li key={project.id} className="flex items-center justify-between">
              <div>
                <p className="text-sm text-ink dark:text-ink-dark">{project.name}</p>
                <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
                  {project.taskCount} open task{project.taskCount === 1 ? "" : "s"}
                </p>
              </div>
              <span className="text-xs text-ink-soft dark:text-ink-soft-dark">{statusLabel[project.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}

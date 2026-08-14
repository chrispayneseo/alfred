import { useEffect, useState } from "react";
import { Screen } from "../components/Screen";
import {
  deleteTask,
  fetchNotes,
  fetchProjects,
  fetchTasks,
  updateTaskStatus,
  type ApiNote,
  type ApiProject,
  type ApiTask,
} from "../integrations/notion/api";

const tabs = ["Tasks", "Notes", "Projects"] as const;
type Tab = (typeof tabs)[number];

function formatUpdatedAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function BrowseScreen() {
  const [tab, setTab] = useState<Tab>("Tasks");
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [notes, setNotes] = useState<ApiNote[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([fetchProjects(), fetchTasks(), fetchNotes()])
      .then(([projectsRes, tasksRes, notesRes]) => {
        setProjects(projectsRes);
        setTasks(tasksRes);
        setNotes(notesRes);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load from Notion."))
      .finally(() => setLoading(false));
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

  const filteredTasks = selectedProjectId ? tasks.filter((t) => t.projectId === selectedProjectId) : tasks;
  const filteredNotes = selectedProjectId ? notes.filter((n) => n.projectId === selectedProjectId) : notes;

  return (
    <Screen title="Browse" subtitle="A window into your Notion workspace">
      <div className="mb-4 flex gap-1 rounded-full border border-line p-1 dark:border-line-dark">
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

      {tab !== "Projects" && projects.length > 0 && (
        <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setSelectedProjectId(undefined)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs ${
              !selectedProjectId
                ? "border-ink text-ink dark:border-ink-dark dark:text-ink-dark"
                : "border-line text-ink-faint dark:border-line-dark dark:text-ink-faint-dark"
            }`}
          >
            All
          </button>
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => setSelectedProjectId(project.id)}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs ${
                selectedProjectId === project.id
                  ? "border-ink text-ink dark:border-ink-dark dark:text-ink-dark"
                  : "border-line text-ink-faint dark:border-line-dark dark:text-ink-faint-dark"
              }`}
            >
              {project.name}
            </button>
          ))}
        </div>
      )}

      {loading && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading from Notion…</p>}
      {error && <p className="text-sm text-claude">{error}</p>}

      {!loading && !error && tab === "Tasks" && (
        <ul className="space-y-2.5">
          {filteredTasks.length === 0 && (
            <li className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing here yet.</li>
          )}
          {filteredTasks.map((task) => (
            <li key={task.id} className="flex items-start gap-3">
              <button
                onClick={() => toggleTask(task)}
                aria-label={task.done ? "Mark as open" : "Mark as done"}
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  task.done
                    ? "border-ink-faint/50 bg-ink-faint/20 text-ink-faint dark:border-ink-faint-dark/50 dark:bg-ink-faint-dark/20 dark:text-ink-faint-dark"
                    : "border-line text-ink-faint hover:border-ink hover:text-ink dark:border-line-dark dark:text-ink-faint-dark dark:hover:border-ink-dark dark:hover:text-ink-dark"
                }`}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </button>
              <div className="min-w-0 flex-1">
                <p className={`text-sm text-ink dark:text-ink-dark ${task.done ? "line-through opacity-50" : ""}`}>
                  {task.title}
                </p>
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

      {!loading && !error && tab === "Notes" && (
        <ul className="space-y-4">
          {filteredNotes.length === 0 && (
            <li className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing here yet.</li>
          )}
          {filteredNotes.map((note) => (
            <li key={note.id}>
              <p className="text-sm text-ink dark:text-ink-dark">{note.title}</p>
              <p className="mt-0.5 text-[11px] text-ink-faint/80 dark:text-ink-faint-dark/80">
                {note.projectName ? `${note.projectName} · ` : ""}
                {formatUpdatedAt(note.updatedAt)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {!loading && !error && tab === "Projects" && (
        <ul className="space-y-3">
          {projects.map((project) => {
            const openTasks = tasks.filter((t) => t.projectId === project.id && !t.done).length;
            return (
              <li key={project.id} className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-ink dark:text-ink-dark">{project.name}</p>
                  <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
                    {openTasks} open task{openTasks === 1 ? "" : "s"}
                  </p>
                </div>
                <span className="text-xs text-ink-soft dark:text-ink-soft-dark">{project.status}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Screen>
  );
}

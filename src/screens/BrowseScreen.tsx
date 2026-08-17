import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Screen } from "../components/Screen";
import {
  deleteNote,
  deleteProject,
  deleteTask,
  fetchNotes,
  fetchProjects,
  fetchTasks,
  updateTaskStatus,
  type ApiNote,
  type ApiProject,
  type ApiTask,
} from "../integrations/notion/api";
import {
  createRecipe,
  deleteRecipe,
  fetchRecipes,
  generateRecipeSuggestions,
  type ApiRecipe,
  type MealType,
  type RecipeEmailResult,
} from "../integrations/recipes/api";

const tabs = ["Tasks", "Notes", "Projects", "Recipes"] as const;
type Tab = (typeof tabs)[number];

const MEAL_TYPES: MealType[] = ["Dinner", "Lunch", "Breakfast"];

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

  const [recipes, setRecipes] = useState<ApiRecipe[]>([]);
  const [addingRecipe, setAddingRecipe] = useState(false);
  const [newRecipeTitle, setNewRecipeTitle] = useState("");
  const [newRecipeMealType, setNewRecipeMealType] = useState<MealType>("Dinner");
  const [savingRecipe, setSavingRecipe] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateResult, setGenerateResult] = useState<RecipeEmailResult>();
  const [generateError, setGenerateError] = useState<string>();

  useEffect(() => {
    Promise.all([fetchProjects(), fetchTasks(), fetchNotes(), fetchRecipes()])
      .then(([projectsRes, tasksRes, notesRes, recipesRes]) => {
        setProjects(projectsRes);
        setTasks(tasksRes);
        setNotes(notesRes);
        setRecipes(recipesRes);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load from Notion."))
      .finally(() => setLoading(false));
  }, []);

  async function addRecipe() {
    const title = newRecipeTitle.trim();
    if (!title) return;
    setSavingRecipe(true);
    try {
      const { id } = await createRecipe(title, newRecipeMealType);
      setRecipes((prev) => [...prev, { id, title, mealType: newRecipeMealType, url: "" }]);
      setNewRecipeTitle("");
      setAddingRecipe(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that recipe.");
    } finally {
      setSavingRecipe(false);
    }
  }

  async function removeRecipe(recipe: ApiRecipe) {
    const prev = recipes;
    setRecipes((p) => p.filter((r) => r.id !== recipe.id));
    try {
      await deleteRecipe(recipe.id);
    } catch {
      setRecipes(prev);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setGenerateError(undefined);
    setGenerateResult(undefined);
    try {
      setGenerateResult(await generateRecipeSuggestions());
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Couldn't send the recipe email right now.");
    } finally {
      setGenerating(false);
    }
  }

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

  async function removeNote(note: ApiNote) {
    const prev = notes;
    setNotes((p) => p.filter((n) => n.id !== note.id));
    try {
      await deleteNote(note.id);
    } catch {
      setNotes(prev);
    }
  }

  async function removeProject(project: ApiProject) {
    const openCount = tasks.filter((t) => t.projectId === project.id).length + notes.filter((n) => n.projectId === project.id).length;
    const itemsNote = openCount > 0 ? ` ${openCount} item${openCount === 1 ? "" : "s"} in it will move to Unsorted.` : "";
    if (!window.confirm(`Delete the "${project.name}" project?${itemsNote}`)) return;

    const prevProjects = projects;
    const prevTasks = tasks;
    const prevNotes = notes;
    setProjects((p) => p.filter((pr) => pr.id !== project.id));
    setTasks((p) => p.map((t) => (t.projectId === project.id ? { ...t, projectId: undefined, projectName: "Unsorted" } : t)));
    setNotes((p) => p.map((n) => (n.projectId === project.id ? { ...n, projectId: undefined, projectName: "Unsorted" } : n)));
    if (selectedProjectId === project.id) setSelectedProjectId(undefined);
    try {
      await deleteProject(project.id);
    } catch (err) {
      setProjects(prevProjects);
      setTasks(prevTasks);
      setNotes(prevNotes);
      setError(err instanceof Error ? err.message : "Couldn't delete that project.");
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

      {tab !== "Projects" && tab !== "Recipes" && projects.length > 0 && (
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
            <li key={note.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink dark:text-ink-dark">{note.title}</p>
                <p className="mt-0.5 text-[11px] text-ink-faint/80 dark:text-ink-faint-dark/80">
                  {note.projectName ? `${note.projectName} · ` : ""}
                  {formatUpdatedAt(note.updatedAt)}
                </p>
              </div>
              <button
                onClick={() => removeNote(note)}
                aria-label="Remove note"
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
                <div className="flex items-center gap-3">
                  {project.name === "Freelance" && (
                    <Link to="/freelance" className="text-xs text-ink-soft underline underline-offset-2 dark:text-ink-soft-dark">
                      Clients
                    </Link>
                  )}
                  <span className="text-xs text-ink-soft dark:text-ink-soft-dark">{project.status}</span>
                  {project.name !== "Unsorted" && (
                    <button
                      onClick={() => removeProject(project)}
                      aria-label="Delete project"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:text-claude dark:text-ink-faint-dark/60"
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && tab === "Recipes" && (
        <div className="space-y-6">
          <div className="rounded-xl border border-line p-3 dark:border-line-dark">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="w-full rounded-full bg-ink py-2 text-xs font-medium text-paper transition-colors disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
            >
              {generating ? "Sending…" : "Generate recipe suggestions"}
            </button>
            {generateResult && (
              <p className="mt-2 text-xs text-ink-soft dark:text-ink-soft-dark">Sent to {generateResult.sentTo}.</p>
            )}
            {generateError && <p className="mt-2 text-xs text-claude">{generateError}</p>}
          </div>

          {MEAL_TYPES.map((mealType) => {
            const forMealType = recipes.filter((r) => r.mealType === mealType);
            return (
              <div key={mealType}>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
                  {mealType}
                </h3>
                {forMealType.length === 0 && (
                  <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing here yet.</p>
                )}
                <ul className="space-y-2">
                  {forMealType.map((recipe) => (
                    <li key={recipe.id} className="flex items-center justify-between gap-3">
                      {recipe.url ? (
                        <a
                          href={recipe.url}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 truncate text-sm text-ink underline-offset-2 hover:underline dark:text-ink-dark"
                        >
                          {recipe.title}
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-sm text-ink dark:text-ink-dark">{recipe.title}</span>
                      )}
                      <button
                        onClick={() => removeRecipe(recipe)}
                        aria-label="Remove recipe"
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:text-claude dark:text-ink-faint-dark/60"
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}

          {addingRecipe ? (
            <div className="space-y-2 rounded-xl border border-line p-3 dark:border-line-dark">
              <input
                autoFocus
                value={newRecipeTitle}
                onChange={(e) => setNewRecipeTitle(e.target.value)}
                placeholder="Recipe title"
                className="w-full rounded-lg border border-line bg-transparent px-3 py-1.5 text-sm text-ink outline-none focus:border-ink-faint dark:border-line-dark dark:text-ink-dark dark:focus:border-ink-faint-dark"
              />
              <div className="flex gap-1 rounded-full border border-line p-1 dark:border-line-dark">
                {MEAL_TYPES.map((mt) => (
                  <button
                    key={mt}
                    onClick={() => setNewRecipeMealType(mt)}
                    className={`flex-1 rounded-full py-1 text-xs font-medium transition-colors ${
                      newRecipeMealType === mt
                        ? "bg-ink text-paper dark:bg-ink-dark dark:text-paper-dark"
                        : "text-ink-soft dark:text-ink-soft-dark"
                    }`}
                  >
                    {mt}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={addRecipe}
                  disabled={savingRecipe || !newRecipeTitle.trim()}
                  className="flex-1 rounded-full bg-ink py-1.5 text-xs font-medium text-paper transition-colors disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                >
                  {savingRecipe ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => {
                    setAddingRecipe(false);
                    setNewRecipeTitle("");
                  }}
                  className="flex-1 rounded-full border border-line py-1.5 text-xs font-medium text-ink-soft dark:border-line-dark dark:text-ink-soft-dark"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAddingRecipe(true)}
              className="w-full rounded-full border border-line py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-ink-faint dark:border-line-dark dark:text-ink-soft-dark dark:hover:border-ink-faint-dark"
            >
              + Add recipe
            </button>
          )}
        </div>
      )}
    </Screen>
  );
}

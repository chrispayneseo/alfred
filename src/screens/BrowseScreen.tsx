import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Screen } from "../components/Screen";
import { UndoToast } from "../components/UndoToast";
import { useUndoableAction } from "../hooks/useUndoableAction";
import {
  deleteNote,
  deleteProject,
  deleteTask,
  fetchNotes,
  fetchProjects,
  fetchTasks,
  restoreNote,
  restoreProject,
  restoreTask,
  updateTaskStatus,
  type ApiNote,
  type ApiProject,
  type ApiTask,
} from "../integrations/notion/api";
import {
  createRecipe,
  deleteRecipe,
  extractRecipeFromUrl,
  fetchRecipes,
  restoreRecipe,
  setRecipeRating,
  type ApiRecipe,
  type MealType,
  type RecipeExtraction,
} from "../integrations/recipes/api";

const tabs = ["Tasks", "Notes", "Projects", "Recipes"] as const;
type Tab = (typeof tabs)[number];

const MEAL_TYPES: MealType[] = ["Breakfast", "Lunch", "Dinner", "Snack", "Baking"];
const RECIPE_SORTS = ["alpha", "rating", "prepTime"] as const;
type RecipeSort = (typeof RECIPE_SORTS)[number];
const RECIPE_SORT_LABELS: Record<RecipeSort, string> = { alpha: "A–Z", rating: "Top rated", prepTime: "Quickest" };
const FILTER_ALL = "All";

function formatUpdatedAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Best-effort minutes for sorting by "Quickest" — prep time is a freeform
 * string from LLM extraction ("15 mins", "1 hr 20 min", ...), not a
 * structured duration, so this just grabs the first hour/minute-ish
 * numbers it can find. Recipes with no parseable time sort last rather
 * than first, so missing data doesn't look like "fastest". */
function parsePrepMinutes(text?: string): number {
  if (!text) return Infinity;
  const hourMatch = text.match(/(\d+)\s*h/i);
  const minMatch = text.match(/(\d+)\s*m/i);
  if (hourMatch || minMatch) {
    return (hourMatch ? parseInt(hourMatch[1], 10) * 60 : 0) + (minMatch ? parseInt(minMatch[1], 10) : 0);
  }
  const bare = text.match(/\d+/);
  return bare ? parseInt(bare[0], 10) : Infinity;
}

function filterSelectClass(active: boolean): string {
  return `rounded-full border px-3 py-1.5 text-xs outline-none transition-colors ${
    active
      ? "border-ink text-ink dark:border-ink-dark dark:text-ink-dark"
      : "border-line text-ink-soft dark:border-line-dark dark:text-ink-soft-dark"
  }`;
}

export function BrowseScreen() {
  const [tab, setTab] = useState<Tab>("Tasks");
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [notes, setNotes] = useState<ApiNote[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const { pending: undoState, trigger: triggerUndo, runUndo } = useUndoableAction();

  const [recipes, setRecipes] = useState<ApiRecipe[]>([]);
  const [addingRecipe, setAddingRecipe] = useState(false);
  const [newRecipeTitle, setNewRecipeTitle] = useState("");
  const [newRecipeMealType, setNewRecipeMealType] = useState<MealType>("Dinner");
  const [savingRecipe, setSavingRecipe] = useState(false);
  const [recipeUrl, setRecipeUrl] = useState("");
  const [extractingRecipe, setExtractingRecipe] = useState(false);
  const [extractError, setExtractError] = useState<string>();
  const [extractedRecipe, setExtractedRecipe] = useState<RecipeExtraction>();
  const [recipeSearch, setRecipeSearch] = useState("");
  const [recipeMealTypeFilter, setRecipeMealTypeFilter] = useState<string>(FILTER_ALL);
  const [recipeCuisineFilter, setRecipeCuisineFilter] = useState<string>(FILTER_ALL);
  const [recipeTagFilter, setRecipeTagFilter] = useState<string>(FILTER_ALL);
  const [recipeSort, setRecipeSort] = useState<RecipeSort>("alpha");

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

  function resetRecipeForm() {
    setAddingRecipe(false);
    setNewRecipeTitle("");
    setNewRecipeMealType("Dinner");
    setRecipeUrl("");
    setExtractError(undefined);
    setExtractedRecipe(undefined);
  }

  async function handleExtractRecipe() {
    const url = recipeUrl.trim();
    if (!url) return;
    setExtractingRecipe(true);
    setExtractError(undefined);
    try {
      const result = await extractRecipeFromUrl(url);
      setNewRecipeTitle(result.title);
      if (result.mealType) setNewRecipeMealType(result.mealType);
      setExtractedRecipe(result);
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "Couldn't read that page.");
    } finally {
      setExtractingRecipe(false);
    }
  }

  async function addRecipe() {
    const title = newRecipeTitle.trim();
    if (!title) return;
    setSavingRecipe(true);
    try {
      const { id } = await createRecipe(
        title,
        newRecipeMealType,
        extractedRecipe && {
          cuisineType: extractedRecipe.cuisineType,
          prepTime: extractedRecipe.prepTime,
          cookTime: extractedRecipe.cookTime,
          sourceUrl: extractedRecipe.sourceUrl,
          ingredients: extractedRecipe.ingredients,
          method: extractedRecipe.method,
          tags: extractedRecipe.tags,
        }
      );
      setRecipes((prev) => [
        ...prev,
        {
          id,
          title,
          mealType: newRecipeMealType,
          url: "",
          cuisineType: extractedRecipe?.cuisineType ?? undefined,
          prepTime: extractedRecipe?.prepTime ?? undefined,
          cookTime: extractedRecipe?.cookTime ?? undefined,
          sourceUrl: extractedRecipe?.sourceUrl,
          ingredients: extractedRecipe?.ingredients,
          method: extractedRecipe?.method,
          tags: extractedRecipe?.tags,
        },
      ]);
      resetRecipeForm();
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
      triggerUndo(`Deleted "${recipe.title}" — recoverable for 30 days`, async () => {
        setRecipes((p) => [...p, recipe]);
        try {
          await restoreRecipe(recipe.id);
        } catch {
          setRecipes((p) => p.filter((r) => r.id !== recipe.id));
        }
      });
    } catch {
      setRecipes(prev);
    }
  }

  async function rateRecipe(recipe: ApiRecipe, star: number) {
    // Clicking the currently-set top star clears the rating; otherwise sets
    // it to the clicked star.
    const next = recipe.rating === star ? null : star;
    const prev = recipes;
    setRecipes((p) => p.map((r) => (r.id === recipe.id ? { ...r, rating: next ?? undefined } : r)));
    try {
      await setRecipeRating(recipe.id, next);
    } catch {
      setRecipes(prev);
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
      triggerUndo(`Deleted "${task.title}" — recoverable for 30 days`, async () => {
        setTasks((p) => [...p, task]);
        try {
          await restoreTask(task.id);
        } catch {
          setTasks((p) => p.filter((t) => t.id !== task.id));
        }
      });
    } catch {
      setTasks(prev);
    }
  }

  async function removeNote(note: ApiNote) {
    const prev = notes;
    setNotes((p) => p.filter((n) => n.id !== note.id));
    try {
      await deleteNote(note.id);
      triggerUndo(`Deleted "${note.title}" — recoverable for 30 days`, async () => {
        setNotes((p) => [...p, note]);
        try {
          await restoreNote(note.id);
        } catch {
          setNotes((p) => p.filter((n) => n.id !== note.id));
        }
      });
    } catch {
      setNotes(prev);
    }
  }

  async function removeProject(project: ApiProject) {
    const prevProjects = projects;
    const prevTasks = tasks;
    const prevNotes = notes;
    setProjects((p) => p.filter((pr) => pr.id !== project.id));
    setTasks((p) => p.map((t) => (t.projectId === project.id ? { ...t, projectId: undefined, projectName: "Unsorted" } : t)));
    setNotes((p) => p.map((n) => (n.projectId === project.id ? { ...n, projectId: undefined, projectName: "Unsorted" } : n)));
    if (selectedProjectId === project.id) setSelectedProjectId(undefined);
    try {
      const { taskIds, noteIds } = await deleteProject(project.id);
      const movedCount = taskIds.length + noteIds.length;
      const movedNote = movedCount > 0 ? ` ${movedCount} item${movedCount === 1 ? "" : "s"} moved to Unsorted.` : "";
      triggerUndo(`Deleted "${project.name}" — recoverable for 30 days.${movedNote}`, async () => {
        setProjects((p) => [...p, project]);
        setTasks((p) => p.map((t) => (taskIds.includes(t.id) ? { ...t, projectId: project.id, projectName: project.name } : t)));
        setNotes((p) => p.map((n) => (noteIds.includes(n.id) ? { ...n, projectId: project.id, projectName: project.name } : n)));
        try {
          await restoreProject(project.id, taskIds, noteIds);
        } catch {
          // Best-effort — matches the app's existing lenient handling of
          // secondary-action failures elsewhere (e.g. rating rollback).
        }
      });
    } catch (err) {
      setProjects(prevProjects);
      setTasks(prevTasks);
      setNotes(prevNotes);
      setError(err instanceof Error ? err.message : "Couldn't delete that project.");
    }
  }

  const filteredTasks = selectedProjectId ? tasks.filter((t) => t.projectId === selectedProjectId) : tasks;
  const filteredNotes = selectedProjectId ? notes.filter((n) => n.projectId === selectedProjectId) : notes;

  const cuisineOptions = useMemo(() => {
    const set = new Set<string>();
    recipes.forEach((r) => r.cuisineType && set.add(r.cuisineType));
    return Array.from(set).sort();
  }, [recipes]);

  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    recipes.forEach((r) => (r.tags ?? []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [recipes]);

  const filteredRecipes = useMemo(() => {
    const query = recipeSearch.trim().toLowerCase();
    const list = recipes.filter((r) => {
      if (recipeMealTypeFilter !== FILTER_ALL && r.mealType !== recipeMealTypeFilter) return false;
      if (recipeCuisineFilter !== FILTER_ALL && r.cuisineType !== recipeCuisineFilter) return false;
      if (recipeTagFilter !== FILTER_ALL && !(r.tags ?? []).includes(recipeTagFilter)) return false;
      if (!query) return true;
      const haystack = [r.title, r.cuisineType, ...(r.ingredients ?? []), ...(r.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    });
    return [...list].sort((a, b) => {
      if (recipeSort === "rating") return (b.rating ?? 0) - (a.rating ?? 0);
      if (recipeSort === "prepTime") return parsePrepMinutes(a.prepTime) - parsePrepMinutes(b.prepTime);
      return a.title.localeCompare(b.title);
    });
  }, [recipes, recipeSearch, recipeMealTypeFilter, recipeCuisineFilter, recipeTagFilter, recipeSort]);

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
                className={`-mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  task.done
                    ? "border-ink-faint/50 bg-ink-faint/20 text-ink-faint dark:border-ink-faint-dark/50 dark:bg-ink-faint-dark/20 dark:text-ink-faint-dark"
                    : "border-line text-ink-faint hover:border-ink hover:text-ink dark:border-line-dark dark:text-ink-faint-dark dark:hover:border-ink-dark dark:hover:text-ink-dark"
                }`}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </button>
              <div className="min-w-0 flex-1 pt-1">
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
                className="-mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:text-claude dark:text-ink-faint-dark/60"
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
              <div className="min-w-0 flex-1 pt-1">
                <p className="text-sm text-ink dark:text-ink-dark">{note.title}</p>
                <p className="mt-0.5 text-[11px] text-ink-faint/80 dark:text-ink-faint-dark/80">
                  {note.projectName ? `${note.projectName} · ` : ""}
                  {formatUpdatedAt(note.updatedAt)}
                </p>
              </div>
              <button
                onClick={() => removeNote(note)}
                aria-label="Remove note"
                className="-mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:text-claude dark:text-ink-faint-dark/60"
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
                <div className="flex items-center gap-1">
                  {project.name === "Freelance" && (
                    <Link to="/freelance" className="mr-2 text-xs text-ink-soft underline underline-offset-2 dark:text-ink-soft-dark">
                      Clients
                    </Link>
                  )}
                  <span className="mr-1 text-xs text-ink-soft dark:text-ink-soft-dark">{project.status}</span>
                  {project.name !== "Unsorted" && (
                    <button
                      onClick={() => removeProject(project)}
                      aria-label="Delete project"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:text-claude dark:text-ink-faint-dark/60"
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
            <Link
              to="/meal-plan"
              className="block w-full rounded-full bg-ink py-2 text-center text-xs font-medium text-paper transition-colors dark:bg-ink-dark dark:text-paper-dark"
            >
              Plan this week's meals
            </Link>
          </div>

          <div className="space-y-2">
            <input
              value={recipeSearch}
              onChange={(e) => setRecipeSearch(e.target.value)}
              placeholder="Search title, ingredients, or tags…"
              className="w-full rounded-full border border-line bg-transparent px-4 py-2 text-sm text-ink outline-none focus:border-ink-faint dark:border-line-dark dark:text-ink-dark dark:focus:border-ink-faint-dark"
            />
            <div className="flex flex-wrap gap-2">
              <select
                value={recipeMealTypeFilter}
                onChange={(e) => setRecipeMealTypeFilter(e.target.value)}
                className={filterSelectClass(recipeMealTypeFilter !== FILTER_ALL)}
              >
                <option value={FILTER_ALL}>All meals</option>
                {MEAL_TYPES.map((mt) => (
                  <option key={mt} value={mt}>
                    {mt}
                  </option>
                ))}
              </select>
              <select
                value={recipeCuisineFilter}
                onChange={(e) => setRecipeCuisineFilter(e.target.value)}
                className={filterSelectClass(recipeCuisineFilter !== FILTER_ALL)}
              >
                <option value={FILTER_ALL}>All cuisines</option>
                {cuisineOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                value={recipeTagFilter}
                onChange={(e) => setRecipeTagFilter(e.target.value)}
                className={filterSelectClass(recipeTagFilter !== FILTER_ALL)}
              >
                <option value={FILTER_ALL}>All tags</option>
                {tagOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                value={recipeSort}
                onChange={(e) => setRecipeSort(e.target.value as RecipeSort)}
                className={filterSelectClass(false)}
              >
                {RECIPE_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {RECIPE_SORT_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
              {filteredRecipes.length} recipe{filteredRecipes.length === 1 ? "" : "s"}
            </p>
          </div>

          {filteredRecipes.length === 0 ? (
            <p className="text-sm text-ink-faint dark:text-ink-faint-dark">No recipes match.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {filteredRecipes.map((recipe) => (
                <li key={recipe.id} className="flex flex-col gap-1.5 rounded-xl border border-line p-3 dark:border-line-dark">
                  <div className="flex items-start justify-between gap-2">
                    {recipe.sourceUrl || recipe.url ? (
                      <a
                        href={recipe.sourceUrl || recipe.url}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 text-sm text-ink underline-offset-2 hover:underline dark:text-ink-dark"
                      >
                        {recipe.title}
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 text-sm text-ink dark:text-ink-dark">{recipe.title}</span>
                    )}
                    <button
                      onClick={() => removeRecipe(recipe)}
                      aria-label="Remove recipe"
                      className="-mt-2 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:text-claude dark:text-ink-faint-dark/60"
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                  <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
                    {[recipe.mealType, recipe.cuisineType, recipe.prepTime && `Prep ${recipe.prepTime}`].filter(Boolean).join(" · ")}
                  </p>
                  <div className="flex gap-0.5">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        onClick={() => rateRecipe(recipe, star)}
                        aria-label={`Rate ${star} star${star === 1 ? "" : "s"}`}
                        className={`flex h-8 w-8 items-center justify-center text-sm leading-none transition-colors ${
                          (recipe.rating ?? 0) >= star ? "text-ink dark:text-ink-dark" : "text-ink-faint/40 dark:text-ink-faint-dark/40"
                        }`}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {addingRecipe ? (
            <div className="space-y-2 rounded-xl border border-line p-3 dark:border-line-dark">
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={recipeUrl}
                  onChange={(e) => setRecipeUrl(e.target.value)}
                  placeholder="Paste a recipe URL (optional)"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-transparent px-3 py-1.5 text-sm text-ink outline-none focus:border-ink-faint dark:border-line-dark dark:text-ink-dark dark:focus:border-ink-faint-dark"
                />
                <button
                  onClick={handleExtractRecipe}
                  disabled={extractingRecipe || !recipeUrl.trim()}
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors disabled:opacity-50 dark:border-line-dark dark:text-ink-soft-dark"
                >
                  {extractingRecipe ? "Reading…" : "Extract"}
                </button>
              </div>
              {extractError && <p className="text-xs text-claude">{extractError}</p>}
              {extractedRecipe && (
                <div className="space-y-1 rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft dark:bg-paper-dark dark:text-ink-soft-dark">
                  {(extractedRecipe.cuisineType || extractedRecipe.prepTime || extractedRecipe.cookTime) && (
                    <p>
                      {[extractedRecipe.cuisineType, extractedRecipe.prepTime && `Prep ${extractedRecipe.prepTime}`, extractedRecipe.cookTime && `Cook ${extractedRecipe.cookTime}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  <p>{extractedRecipe.ingredients.length} ingredients</p>
                  <p>{extractedRecipe.method.slice(0, 200)}…</p>
                </div>
              )}

              <input
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
                  onClick={resetRecipeForm}
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
      {undoState && <UndoToast message={undoState.message} onUndo={runUndo} />}
    </Screen>
  );
}

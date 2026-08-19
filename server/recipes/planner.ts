// Interactive weekly meal-plan builder — replaces the old fixed Sunday-noon
// suggestion email (server/recipes/weeklyEmail.ts, select.ts, weatherRank.ts,
// all deleted). One suggestion at a time, linear day-by-day flow: the
// "current day" is always whichever day is still 'pending', found by
// scanning day_index order — no separate cursor to keep in sync.
//
// Candidate selection is entirely deterministic (no LLM call per
// suggestion, unlike the old weather-ranking approach) — recency exclusion,
// category exclusion, and weather-affinity preference are all plain
// filtering over the already-classified Recipe Bank (see
// dishCategories.ts), which keeps each accept/reject/skip instant.
import { ensureSchema, getSql, type Env } from "../db.js";
import type { NotionRepo, RecipeRecord } from "../notion/queries.js";
import { CATEGORY_WEATHER_AFFINITY, isDishCategory } from "./dishCategories.js";
import { sendEmail } from "./email.js";
import type { RecipeEmailEnv } from "./env.js";
import type { LlmEnv } from "../llm/env.js";
import { scaleIngredientsForHousehold, type RecipeToScale } from "./scaling.js";
import { fetchDailyForecasts } from "../weather/openMeteo.js";
import type { WeatherEnv } from "../weather/env.js";

const ROLLING_WEEK_DAYS = 7;
const RECENCY_WINDOW_DAYS = 14;

export interface MealPlanCandidate {
  id: string;
  title: string;
  url: string;
  category?: string;
  cuisineType?: string;
  prepTime?: string;
  cookTime?: string;
}

export interface MealPlanDay {
  dayIndex: number;
  date: string;
  dayLabel: string;
  status: "pending" | "accepted" | "skipped";
  recipeTitle?: string;
  candidate?: MealPlanCandidate;
}

export interface MealPlanState {
  sessionId: string;
  status: "active" | "sent";
  days: MealPlanDay[];
  allResolved: boolean;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

interface DayRow {
  id: string;
  session_id: string;
  day_index: number;
  date: string;
  status: string;
  recipe_id: string | null;
  category: string | null;
  candidate_recipe_id: string | null;
  rejected_recipe_ids: string;
}

function dayLabel(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long" });
}

type WeatherAffinity = "cold" | "warm" | "neutral";

function classifyDayWeather(day?: { highC: number; lowC: number; precipProbability: number }): WeatherAffinity {
  if (!day) return "neutral";
  const avg = (day.highC + day.lowC) / 2;
  if (avg <= 10 || day.precipProbability >= 60) return "cold";
  if (avg >= 18 && day.precipProbability < 40) return "warm";
  return "neutral";
}

/** Recency exclusion and category exclusion are both preferences, not
 * absolutes — each is dropped in turn (recency first) if honoring it would
 * leave nothing to suggest, same "never come up short" philosophy as the
 * old select.ts. Among whatever survives, prefer a weather-affinity match;
 * pick randomly among the (possibly narrowed) result for variety across
 * sessions rather than always resurfacing the same first pick. */
function pickCandidate(
  pool: RecipeRecord[],
  excludeIds: Set<string>,
  excludeCategories: Set<string>,
  recentlySent: Set<string>,
  dayAffinity: WeatherAffinity
): RecipeRecord | undefined {
  const base = pool.filter((r) => !excludeIds.has(r.id));
  const withCategoryRule = base.filter((r) => !r.category || !excludeCategories.has(r.category));
  const withRecencyRule = withCategoryRule.filter((r) => !recentlySent.has(r.id));
  const eligible = withRecencyRule.length > 0 ? withRecencyRule : withCategoryRule.length > 0 ? withCategoryRule : base;
  if (eligible.length === 0) return undefined;

  const affinityMatches = eligible.filter((r) => r.category && isDishCategory(r.category) && CATEGORY_WEATHER_AFFINITY[r.category] === dayAffinity);
  const finalPool = affinityMatches.length > 0 ? affinityMatches : eligible;
  return finalPool[Math.floor(Math.random() * finalPool.length)];
}

async function recentlySentIds(env: Env): Promise<Set<string>> {
  const sql = await db(env);
  const rows = (await sql.query(
    `SELECT DISTINCT recipe_id FROM recipe_sends WHERE sent_at >= now() - ($1 || ' days')::interval`,
    [String(RECENCY_WINDOW_DAYS)]
  )) as { recipe_id: string }[];
  return new Set(rows.map((r) => r.recipe_id));
}

async function loadDays(env: Env, sessionId: string): Promise<DayRow[]> {
  const sql = await db(env);
  return (await sql.query("SELECT * FROM meal_plan_days WHERE session_id = $1 ORDER BY day_index ASC", [sessionId])) as DayRow[];
}

async function recordRecipeSends(env: Env, recipeIds: string[]): Promise<void> {
  if (recipeIds.length === 0) return;
  const sql = await db(env);
  await Promise.all(recipeIds.map((id) => sql.query("INSERT INTO recipe_sends (recipe_id) VALUES ($1)", [id])));
}

/** Loads current state, generating and persisting a candidate for the
 * current pending day if it doesn't have one yet — called after every
 * mutation (and on a bare fetch) so the caller always gets a live,
 * ready-to-render state. */
async function refreshState(dbEnv: Env, repo: NotionRepo, weatherEnv: WeatherEnv, sessionId: string, sessionStatus: string): Promise<MealPlanState> {
  const days = await loadDays(dbEnv, sessionId);
  const pool = await repo.listRecipes("Dinner");
  const recipeMap = new Map(pool.map((r) => [r.id, r]));

  const current = days.find((d) => d.status === "pending");
  if (current && !current.candidate_recipe_id) {
    const [recentlySent, forecasts] = await Promise.all([recentlySentIds(dbEnv), fetchDailyForecasts(weatherEnv, ROLLING_WEEK_DAYS)]);
    const acceptedCategories = new Set(days.filter((d) => d.status === "accepted" && d.category).map((d) => d.category!));
    const rejectedThisDay = new Set(JSON.parse(current.rejected_recipe_ids) as string[]);
    const forecastForDay = forecasts?.find((f) => f.date === current.date);
    const affinity = classifyDayWeather(forecastForDay);
    const pick = pickCandidate(pool, rejectedThisDay, acceptedCategories, recentlySent, affinity);

    const sql = await db(dbEnv);
    await sql.query("UPDATE meal_plan_days SET candidate_recipe_id = $1 WHERE id = $2", [pick?.id ?? null, current.id]);
    current.candidate_recipe_id = pick?.id ?? null;
  }

  const stateDays: MealPlanDay[] = days.map((d) => {
    const base: MealPlanDay = { dayIndex: d.day_index, date: d.date, dayLabel: dayLabel(d.date), status: d.status as MealPlanDay["status"] };
    if (d.status === "accepted" && d.recipe_id) {
      base.recipeTitle = recipeMap.get(d.recipe_id)?.title ?? "Recipe";
    }
    if (d.status === "pending" && d.candidate_recipe_id) {
      const recipe = recipeMap.get(d.candidate_recipe_id);
      if (recipe) {
        base.candidate = {
          id: recipe.id,
          title: recipe.title,
          url: recipe.url,
          category: recipe.category,
          cuisineType: recipe.cuisineType,
          prepTime: recipe.prepTime,
          cookTime: recipe.cookTime,
        };
      }
    }
    return base;
  });

  return { sessionId, status: sessionStatus === "sent" ? "sent" : "active", days: stateDays, allResolved: stateDays.every((d) => d.status !== "pending") };
}

/** Starts a fresh rolling-week plan, superseding any other still-active
 * session — re-running before a previous plan is sent simply restarts. */
export async function startMealPlan(dbEnv: Env, repo: NotionRepo, weatherEnv: WeatherEnv): Promise<MealPlanState> {
  const sql = await db(dbEnv);
  const oldActive = (await sql.query("SELECT id FROM meal_plan_sessions WHERE status = 'active'")) as { id: string }[];
  for (const row of oldActive) {
    await sql.query("DELETE FROM meal_plan_days WHERE session_id = $1", [row.id]);
    await sql.query("DELETE FROM meal_plan_sessions WHERE id = $1", [row.id]);
  }

  const sessionId = crypto.randomUUID();
  await sql.query("INSERT INTO meal_plan_sessions (id, status) VALUES ($1, 'active')", [sessionId]);

  const today = new Date();
  for (let i = 0; i < ROLLING_WEEK_DAYS; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    await sql.query("INSERT INTO meal_plan_days (id, session_id, day_index, date, status) VALUES ($1, $2, $3, $4, 'pending')", [
      crypto.randomUUID(),
      sessionId,
      i,
      date.toISOString().slice(0, 10),
    ]);
  }

  return refreshState(dbEnv, repo, weatherEnv, sessionId, "active");
}

/** The currently in-progress session, if any — used on page load so the
 * planner UI can resume rather than always requiring a fresh start. */
export async function getCurrentMealPlan(dbEnv: Env, repo: NotionRepo, weatherEnv: WeatherEnv): Promise<MealPlanState | undefined> {
  const sql = await db(dbEnv);
  const [session] = (await sql.query(
    "SELECT id, status FROM meal_plan_sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
  )) as { id: string; status: string }[];
  if (!session) return undefined;
  return refreshState(dbEnv, repo, weatherEnv, session.id, session.status);
}

export async function acceptCurrentDay(dbEnv: Env, repo: NotionRepo, weatherEnv: WeatherEnv, sessionId: string): Promise<MealPlanState> {
  const days = await loadDays(dbEnv, sessionId);
  const current = days.find((d) => d.status === "pending");
  if (current?.candidate_recipe_id) {
    const pool = await repo.listRecipes("Dinner");
    const recipe = pool.find((r) => r.id === current.candidate_recipe_id);
    const sql = await db(dbEnv);
    await sql.query(
      "UPDATE meal_plan_days SET status = 'accepted', recipe_id = $1, category = $2, candidate_recipe_id = NULL WHERE id = $3",
      [current.candidate_recipe_id, recipe?.category ?? null, current.id]
    );
  }
  return refreshState(dbEnv, repo, weatherEnv, sessionId, "active");
}

export async function rejectCurrentDay(dbEnv: Env, repo: NotionRepo, weatherEnv: WeatherEnv, sessionId: string): Promise<MealPlanState> {
  const days = await loadDays(dbEnv, sessionId);
  const current = days.find((d) => d.status === "pending");
  if (current?.candidate_recipe_id) {
    const rejected = JSON.parse(current.rejected_recipe_ids) as string[];
    rejected.push(current.candidate_recipe_id);
    const sql = await db(dbEnv);
    await sql.query("UPDATE meal_plan_days SET rejected_recipe_ids = $1, candidate_recipe_id = NULL WHERE id = $2", [
      JSON.stringify(rejected),
      current.id,
    ]);
  }
  return refreshState(dbEnv, repo, weatherEnv, sessionId, "active");
}

export async function skipCurrentDay(dbEnv: Env, repo: NotionRepo, weatherEnv: WeatherEnv, sessionId: string): Promise<MealPlanState> {
  const days = await loadDays(dbEnv, sessionId);
  const current = days.find((d) => d.status === "pending");
  if (current) {
    const sql = await db(dbEnv);
    await sql.query("UPDATE meal_plan_days SET status = 'skipped', candidate_recipe_id = NULL WHERE id = $1", [current.id]);
  }
  return refreshState(dbEnv, repo, weatherEnv, sessionId, "active");
}

function formatEmailBody(days: { dayLabel: string; date: string; title: string; ingredients: string[] }[]): string {
  return days.map((d) => `${d.dayLabel} (${d.date})\n${d.title}\n${d.ingredients.map((i) => `- ${i}`).join("\n")}`).join("\n\n");
}

/** Every day must be accepted or skipped first. Scales ingredients for the
 * household in one batched call, sends the email via the existing Resend
 * pipeline, records the accepted recipes' sends for future recency
 * exclusion, and marks the session sent. */
export async function sendMealPlan(
  dbEnv: Env,
  repo: NotionRepo,
  recipeEmailEnv: RecipeEmailEnv,
  llmEnv: LlmEnv,
  sessionId: string
): Promise<{ sentTo: string; mealCount: number }> {
  const days = await loadDays(dbEnv, sessionId);
  if (days.some((d) => d.status === "pending")) throw new Error("Every day must be accepted or skipped before sending.");

  const accepted = days.filter((d) => d.status === "accepted" && d.recipe_id);
  const pool = await repo.listRecipes("Dinner");
  const recipeMap = new Map(pool.map((r) => [r.id, r]));

  const toScale: RecipeToScale[] = [];
  for (const d of accepted) {
    const recipe = recipeMap.get(d.recipe_id!);
    if (recipe) toScale.push({ id: recipe.id, title: recipe.title, ingredients: recipe.ingredients ?? [], method: recipe.method });
  }
  const scaled = await scaleIngredientsForHousehold(dbEnv, llmEnv, toScale);

  const emailDays = accepted
    .map((d) => {
      const recipe = recipeMap.get(d.recipe_id!);
      if (!recipe) return undefined;
      return { dayLabel: dayLabel(d.date), date: d.date, title: recipe.title, ingredients: scaled.get(recipe.id) ?? recipe.ingredients ?? [] };
    })
    .filter((d): d is NonNullable<typeof d> => d !== undefined);

  if (emailDays.length === 0) throw new Error("No meals were accepted — nothing to send.");

  await sendEmail(recipeEmailEnv.resendApiKey, recipeEmailEnv.destinationEmail, "This week's meal plan", formatEmailBody(emailDays));
  await recordRecipeSends(
    dbEnv,
    accepted.map((d) => d.recipe_id!)
  );

  const sql = await db(dbEnv);
  await sql.query("UPDATE meal_plan_sessions SET status = 'sent' WHERE id = $1", [sessionId]);

  return { sentTo: recipeEmailEnv.destinationEmail, mealCount: emailDays.length };
}

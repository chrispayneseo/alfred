import { ensureSchema, getSql, type Env } from "../db.js";
import type { LlmEnv } from "../llm/env.js";
import type { NotionRepo, RecipeRecord } from "../notion/queries.js";
import { type MealType } from "../notion/schema.js";
import { fetchWeatherOutlook } from "../weather/openMeteo.js";
import type { WeatherEnv } from "../weather/env.js";
import { rankRecipesByWeather } from "./weatherRank.js";

// How much wider than the target count to take the recency-sorted shortlist
// before weather-ranking it — gives the ranking step real choices to work
// with (rather than just the bare minimum, which would leave it nothing to
// prefer between, both for weather fit and for dish-category variety) while
// still keeping recency as the dominant signal, since the shortlist itself
// is still recency-ordered before any re-ranking.
const SHORTLIST_MULTIPLIER = 6;

// Only Dinner/Lunch/Breakfast are ever included in the weekly email — Snack
// and Baking are Recipe Bank categories with no slot in that selection.
// Dinner first: it's the largest, most category-diverse pool, and
// dish-category variety is tracked across the WHOLE email (see
// usedCategories below), not per meal type — a dinner curry rules out a
// lunch curry the same week, not just another dinner curry.
const MEAL_TYPE_ORDER: MealType[] = ["Dinner", "Lunch", "Breakfast", "Snack", "Baking"];
const MEAL_TYPE_COUNTS: Record<MealType, number> = { Dinner: 5, Lunch: 3, Breakfast: 2, Snack: 0, Baking: 0 };

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

async function lastSentByRecipeId(env: Env, recipeIds: string[]): Promise<Map<string, number>> {
  if (recipeIds.length === 0) return new Map();
  const sql = await db(env);
  const rows = (await sql.query(
    `SELECT recipe_id, MAX(sent_at) AS last_sent FROM recipe_sends WHERE recipe_id = ANY($1) GROUP BY recipe_id`,
    [recipeIds]
  )) as { recipe_id: string; last_sent: string }[];
  return new Map(rows.map((r) => [r.recipe_id, new Date(r.last_sent).getTime()]));
}

/** Picks this week's recipes per meal type, least-recently-sent first — a
 * recipe that's never been sent has no row in recipe_sends at all, so it
 * always sorts before one that has (undefined last-sent time treated as
 * epoch 0).
 *
 * Weather then biases WHICH of the least-recently-sent recipes actually get
 * picked (e.g. deprioritizing a hearty stew during a heatwave), and a shared
 * `usedCategories` set (curry, soup, pasta, ...) enforces no two dishes of
 * the same kind across the whole email, not just within one meal type —
 * both re-rank a shortlist wider than the target count rather than
 * overriding recency outright, and both degrade gracefully: if the weather
 * fetch/ranking call fails, or a meal type's pool doesn't have enough
 * distinct categories to fill every slot, this falls back to pure recency
 * (with repeats) rather than coming up short — see weatherRank.ts. */
export async function selectWeeklyRecipes(env: Env, repo: NotionRepo, weatherEnv: WeatherEnv, llmEnv: LlmEnv): Promise<Record<MealType, RecipeRecord[]>> {
  const outlook = await fetchWeatherOutlook(weatherEnv);
  const result = {} as Record<MealType, RecipeRecord[]>;
  const usedCategories = new Set<string>();

  for (const mealType of MEAL_TYPE_ORDER) {
    const count = MEAL_TYPE_COUNTS[mealType];
    if (count === 0) {
      result[mealType] = [];
      continue;
    }
    const candidates = await repo.listRecipes(mealType);
    const lastSent = await lastSentByRecipeId(
      env,
      candidates.map((c) => c.id)
    );
    const sorted = [...candidates].sort((a, b) => (lastSent.get(a.id) ?? 0) - (lastSent.get(b.id) ?? 0));
    const shortlist = sorted.slice(0, Math.min(sorted.length, count * SHORTLIST_MULTIPLIER));
    const ranked = outlook ? await rankRecipesByWeather(env, llmEnv, outlook, mealType, shortlist) : shortlist.map((recipe) => ({ recipe, category: "" }));

    const picked: RecipeRecord[] = [];
    for (const { recipe, category } of ranked) {
      if (picked.length >= count) break;
      // "" (categorization skipped/failed) and "other" (genuinely doesn't
      // fit the fixed vocabulary) are never treated as duplicates of each
      // other — only a real, matched category blocks a repeat.
      if (category && category !== "other" && usedCategories.has(category)) continue;
      picked.push(recipe);
      if (category && category !== "other") usedCategories.add(category);
    }
    // Degrade gracefully: if the shortlist didn't have enough distinct
    // categories to fill every slot, allow repeats rather than coming up
    // short — same philosophy as recency's own never-fail slice.
    if (picked.length < count) {
      for (const { recipe } of ranked) {
        if (picked.length >= count) break;
        if (!picked.includes(recipe)) picked.push(recipe);
      }
    }
    result[mealType] = picked;
  }
  return result;
}

export async function recordRecipeSends(env: Env, recipeIds: string[]): Promise<void> {
  if (recipeIds.length === 0) return;
  const sql = await db(env);
  await Promise.all(recipeIds.map((id) => sql.query(`INSERT INTO recipe_sends (recipe_id) VALUES ($1)`, [id])));
}

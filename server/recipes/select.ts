import { ensureSchema, getSql, type Env } from "../db.js";
import type { NotionRepo, RecipeRecord } from "../notion/queries.js";
import { MEAL_TYPES, type MealType } from "../notion/schema.js";

const MEAL_TYPE_COUNTS: Record<MealType, number> = { Dinner: 5, Lunch: 3, Breakfast: 2 };

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
 * epoch 0). Repeats only happen once every distinct recipe for that meal
 * type has already been picked at least once — no separate "are there
 * enough recipes?" branch needed, the sort alone degrades gracefully when
 * a meal type's pool is smaller than the number needed. */
export async function selectWeeklyRecipes(env: Env, repo: NotionRepo): Promise<Record<MealType, RecipeRecord[]>> {
  const result = {} as Record<MealType, RecipeRecord[]>;
  for (const mealType of MEAL_TYPES) {
    const candidates = await repo.listRecipes(mealType);
    const lastSent = await lastSentByRecipeId(
      env,
      candidates.map((c) => c.id)
    );
    const sorted = [...candidates].sort((a, b) => (lastSent.get(a.id) ?? 0) - (lastSent.get(b.id) ?? 0));
    result[mealType] = sorted.slice(0, MEAL_TYPE_COUNTS[mealType]);
  }
  return result;
}

export async function recordRecipeSends(env: Env, recipeIds: string[]): Promise<void> {
  if (recipeIds.length === 0) return;
  const sql = await db(env);
  await Promise.all(recipeIds.map((id) => sql.query(`INSERT INTO recipe_sends (recipe_id) VALUES ($1)`, [id])));
}

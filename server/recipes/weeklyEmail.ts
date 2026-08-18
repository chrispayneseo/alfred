// Weekly recipe suggestion email — selection + send is shared between the
// automatic Sunday-noon check and the on-demand "Generate recipe
// suggestions" button; only the gating differs.
import { ensureSchema, getSql, type Env } from "../db.js";
import { getIsoWeekKey } from "../digest/weeklyDigest.js";
import { DEFAULT_TIME_ZONE } from "../google/calendar.js";
import type { LlmEnv } from "../llm/env.js";
import type { NotionRepo, RecipeRecord } from "../notion/queries.js";
import type { MealType } from "../notion/schema.js";
import { fetchWeatherOutlook } from "../weather/openMeteo.js";
import type { WeatherEnv } from "../weather/env.js";
import { sendEmail } from "./email.js";
import type { RecipeEmailEnv } from "./env.js";
import { recordRecipeSends, selectWeeklyRecipes } from "./select.js";

// The weekly email only ever covers these three — Snack/Baking are Recipe
// Bank categories with no slot in the weekly selection (see select.ts's
// MEAL_TYPE_COUNTS), so iterating the full MEAL_TYPES list here would add
// empty "no recipes yet" sections to every email.
const EMAIL_MEAL_TYPES: MealType[] = ["Dinner", "Lunch", "Breakfast"];

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

async function wasSentThisWeek(env: Env, weekKey: string): Promise<boolean> {
  const sql = await db(env);
  const rows = (await sql.query("SELECT 1 FROM recipe_email_weekly_log WHERE week_key = $1", [weekKey])) as unknown[];
  return rows.length > 0;
}

async function markSentThisWeek(env: Env, weekKey: string): Promise<void> {
  const sql = await db(env);
  await sql.query("INSERT INTO recipe_email_weekly_log (week_key) VALUES ($1) ON CONFLICT (week_key) DO NOTHING", [weekKey]);
}

/** True once it's Sunday and at least noon, evaluated in the user's local
 * time zone via Intl (handles BST/GMT correctly, unlike a fixed UTC
 * offset). The gmail-refresh cron pings every ~30 min and GitHub Actions'
 * own scheduling isn't exact either, so this fires "sometime shortly after
 * noon Sunday," not at noon precisely — accepted per the existing
 * check-on-trigger pattern (server/digest/weeklyDigest.ts), which only
 * gates on day-of-week at all today. */
function isSundayNoonOrLater(now: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", hour12: false }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return weekday === "Sun" && hour >= 12;
}

function formatEmailBody(selection: Record<MealType, RecipeRecord[]>, outlookLine?: string): string {
  const sections = EMAIL_MEAL_TYPES.map((mealType) => {
    const recipes = selection[mealType];
    if (recipes.length === 0) return `${mealType}\nNo recipes in the bank yet for this meal type — add some from the Recipe Bank in Alfred.`;
    return `${mealType}\n${recipes.map((r) => `- ${r.title}\n  ${r.url}`).join("\n")}`;
  });
  return [outlookLine, ...sections].filter(Boolean).join("\n\n");
}

/** Selects, sends, and records this week's recipes. Shared by the automatic
 * check and the on-demand button — the button bypasses the day/time/
 * idempotency gate entirely (server/handleApiRequest.ts calls this
 * directly), but still records sends here so recency tracking stays
 * accurate regardless of what triggered the email. `weatherEnv`/`llmEnv`
 * bias the selection itself toward the week's weather (see select.ts) —
 * fetched again here (cheap, no API key) just to surface the same outlook
 * as a one-line "why these picks" note at the top of the email. */
export async function generateAndSendRecipeEmail(
  env: Env,
  recipeEmailEnv: RecipeEmailEnv,
  repo: NotionRepo,
  weatherEnv: WeatherEnv,
  llmEnv: LlmEnv
): Promise<Record<MealType, RecipeRecord[]>> {
  const [selection, outlook] = await Promise.all([selectWeeklyRecipes(env, repo, weatherEnv, llmEnv), fetchWeatherOutlook(weatherEnv)]);
  const allIds = EMAIL_MEAL_TYPES.flatMap((mealType) => selection[mealType].map((r) => r.id));
  await sendEmail(recipeEmailEnv.resendApiKey, recipeEmailEnv.destinationEmail, "This week's recipe suggestions", formatEmailBody(selection, outlook?.summaryLine));
  await recordRecipeSends(env, allIds);
  return selection;
}

/** Check-on-cron-ping entry point, mirroring costTracking/alerts.ts's
 * checkCostAlerts: called unconditionally on every gmail-refresh cron ping,
 * no-ops silently if not configured or it isn't Sunday noon yet (local
 * time), and is idempotent per ISO week so repeated pings after the first
 * send that week don't send again. */
export async function checkRecipeEmail(env: Env, recipeEmailEnv: RecipeEmailEnv, repo: NotionRepo, weatherEnv: WeatherEnv, llmEnv: LlmEnv): Promise<void> {
  if (!recipeEmailEnv.resendApiKey || !recipeEmailEnv.destinationEmail) return;
  const now = new Date();
  if (!isSundayNoonOrLater(now, DEFAULT_TIME_ZONE)) return;
  const weekKey = getIsoWeekKey(now);
  if (await wasSentThisWeek(env, weekKey)) return;
  await generateAndSendRecipeEmail(env, recipeEmailEnv, repo, weatherEnv, llmEnv);
  await markSentThisWeek(env, weekKey);
}

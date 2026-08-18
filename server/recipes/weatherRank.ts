// Re-ranks a recency-sorted recipe shortlist by fit with the week's weather
// outlook — e.g. deprioritizing a hearty stew during a summer heatwave, or a
// cold salad during a cold snap — and tags each with a short dish-category
// label (e.g. "curry", "soup") so select.ts can enforce "no two curries in
// one email" deterministically rather than just asking the model not to
// repeat itself. Never throws; falls back to the candidates in their
// original (recency) order with blank categories on any failure, so a
// weather API or LLM hiccup never breaks recipe selection — it just loses
// the weather bias and category variety for that one run.
import { z } from "zod";
import type { Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import type { RecipeRecord } from "../notion/queries.js";
import type { WeatherOutlook } from "../weather/openMeteo.js";

// A fixed vocabulary, not freeform — this function is called once per meal
// type with no visibility into what label another call chose for its own
// candidates, so two independently-run calls describing the same kind of
// dish ("soup" vs "minestrone soup", "curry" vs "chicken curry") would
// silently defeat exact-match deduplication in select.ts. A closed enum
// guarantees the same dish always gets the same string.
const DISH_CATEGORIES = [
  "curry",
  "soup",
  "stew-or-casserole",
  "pasta",
  "stir-fry",
  "salad",
  "roast",
  "traybake",
  "pizza",
  "sandwich-or-wrap",
  "rice-or-risotto",
  "noodles",
  "pie-or-bake",
  "grilled-or-bbq",
  "fritters-or-pancakes",
  "porridge-or-oats",
  "eggs",
  "baked-goods",
  "smoothie-or-drink",
  "other",
] as const;

const RankSchema = z.object({ picks: z.array(z.object({ id: z.string(), category: z.enum(DISH_CATEGORIES) })) });

const SYSTEM_PROMPT = `You help choose weather-appropriate, varied recipes for a weekly meal-suggestion email. Given this week's weather outlook and a list of candidate recipes (already ordered from least-recently-suggested to most-recently-suggested), return every candidate exactly once, re-ordered so the ones that best fit this week's weather come first — e.g. don't put a hearty stew, heavy roast, or rich baked dish first during warm/hot weather; don't put a cold salad, chilled soup, or iced drink first during cold weather. Still prefer earlier (less-recently-suggested) candidates over later ones whenever weather fit is roughly equal — don't reshuffle purely on a whim.

For each candidate, also assign a "category" describing the kind of dish it is — pick exactly one from this fixed list (use "other" only if genuinely nothing else fits): ${DISH_CATEGORIES.join(", ")}.

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"picks": [{"id": string, "category": string}, ...]}`;

function buildUserText(outlook: WeatherOutlook, mealType: string, candidates: RecipeRecord[]): string {
  const list = candidates
    .map((c, i) => `${i + 1}. id="${c.id}" — "${c.title}"${c.cuisineType ? ` (${c.cuisineType})` : ""}${c.tags?.length ? ` [${c.tags.join(", ")}]` : ""}`)
    .join("\n");
  return `${outlook.summaryLine}\n\nMeal type: ${mealType}\n\nCandidates (least-recently-suggested first):\n${list}`;
}

function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

export type DishCategory = (typeof DISH_CATEGORIES)[number];

export interface RankedPick {
  recipe: RecipeRecord;
  /** One of DISH_CATEGORIES, or "" if categorization failed/was skipped —
   * callers should never dedupe against an empty category. */
  category: DishCategory | "";
}

/** Re-orders `candidates` (already sorted least-recently-sent first) by fit
 * with the week's weather outlook and tags each with a dish category,
 * keeping the recency order as a tiebreaker per the prompt above.
 *
 * Salvages a partial response rather than discarding it wholesale: on a
 * shortlist of ~20 items, a model occasionally drops or duplicates one id —
 * every successfully-matched candidate keeps its real category (still
 * usable for dedup), and only the genuinely missing ones fall back to a
 * blank category appended at the end. Only a total failure (fetch error,
 * unparseable JSON, or a response with zero valid ids) falls back to
 * `candidates` in their original order with every category blank — the
 * caller always gets a usable, complete list either way, just with less (or
 * no) weather bias / category-diversity signal on a partial or failed run. */
export async function rankRecipesByWeather(
  dbEnv: Env,
  llmEnv: LlmEnv,
  outlook: WeatherOutlook,
  mealType: string,
  candidates: RecipeRecord[]
): Promise<RankedPick[]> {
  const fallback: RankedPick[] = candidates.map((recipe) => ({ recipe, category: "" }));
  if (candidates.length === 0) return fallback;
  try {
    const userText = buildUserText(outlook, mealType, candidates);
    const result = await routedComplete(llmEnv, userText, SYSTEM_PROMPT, userText, 3000, "claude-haiku-4-5");
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "recipe_weather_ranking",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    const parsed = RankSchema.parse(parseJsonLoose(result.text));
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const picks: RankedPick[] = [];
    const seenIds = new Set<string>();
    for (const { id, category } of parsed.picks) {
      const recipe = byId.get(id);
      if (recipe && !seenIds.has(id)) {
        picks.push({ recipe, category });
        seenIds.add(id);
      }
    }
    if (picks.length === 0) return fallback;
    // Backfill anything the model dropped, blank/unranked at the end —
    // still weather-biased and category-tagged for everything it DID
    // return, rather than losing that signal for the whole meal type.
    for (const recipe of candidates) {
      if (!seenIds.has(recipe.id)) picks.push({ recipe, category: "" });
    }
    return picks;
  } catch (error) {
    console.error(`[recipes] weather ranking failed for ${mealType}:`, error);
    return fallback;
  }
}

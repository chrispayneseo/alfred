// Re-ranks a recency-sorted recipe shortlist by fit with the week's weather
// outlook — e.g. deprioritizing a hearty stew during a summer heatwave, or a
// cold salad during a cold snap. Never throws; falls back to returning the
// candidates in their original (recency) order on any failure, so a weather
// API or LLM hiccup never breaks recipe selection — it just loses the
// weather bias for that one run.
import { z } from "zod";
import type { Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import type { RecipeRecord } from "../notion/queries.js";
import type { WeatherOutlook } from "../weather/openMeteo.js";

const RankSchema = z.object({ orderedIds: z.array(z.string()) });

const SYSTEM_PROMPT = `You help choose weather-appropriate recipes for a weekly meal-suggestion email. Given this week's weather outlook and a list of candidate recipes (already ordered from least-recently-suggested to most-recently-suggested), re-order the candidates so the ones that best fit this week's weather come first — e.g. don't put a hearty stew, heavy roast, or rich baked dish first during warm/hot weather; don't put a cold salad, chilled soup, or iced drink first during cold weather. Still prefer earlier (less-recently-suggested) candidates over later ones whenever weather fit is roughly equal — don't reshuffle purely on a whim. Every candidate must appear exactly once in your response, none added or dropped.

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"orderedIds": string[]}`;

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

/** Re-orders `candidates` (already sorted least-recently-sent first) by fit
 * with the week's weather outlook, keeping the recency order as a
 * tiebreaker per the prompt above. Returns `candidates` unchanged if the
 * ranking call fails, or if the model's response can't be trusted (wrong
 * count/ids) — the caller still gets a usable, recency-ordered list either
 * way, just without the weather bias. */
export async function rankRecipesByWeather(
  dbEnv: Env,
  llmEnv: LlmEnv,
  outlook: WeatherOutlook,
  mealType: string,
  candidates: RecipeRecord[]
): Promise<RecipeRecord[]> {
  if (candidates.length === 0) return candidates;
  try {
    const userText = buildUserText(outlook, mealType, candidates);
    const result = await routedComplete(llmEnv, userText, SYSTEM_PROMPT, userText, 1000, "claude-haiku-4-5");
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "recipe_weather_ranking",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    const parsed = RankSchema.parse(parseJsonLoose(result.text));
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const ordered = parsed.orderedIds.map((id) => byId.get(id)).filter((c): c is RecipeRecord => Boolean(c));
    if (ordered.length !== candidates.length) return candidates;
    return ordered;
  } catch (error) {
    console.error(`[recipes] weather ranking failed for ${mealType}:`, error);
    return candidates;
  }
}

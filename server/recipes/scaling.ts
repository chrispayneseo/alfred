// LLM-based ingredient scaling for the meal-plan email — Recipe Bank entries
// don't record their original serving size, so this asks the model to infer
// a reasonable original yield from context (quantities, any "serves N" in
// the method) and rescale for the household. One batched call covering
// every accepted day, not one call per recipe.
import { logModelCall } from "../costTracking/callLog.js";
import type { Env } from "../db.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";

const HOUSEHOLD = "3 adults and 1 child";

export interface RecipeToScale {
  id: string;
  title: string;
  ingredients: string[];
  method?: string;
}

interface RawScaled {
  id: string;
  ingredients: string[];
}

const SYSTEM_PROMPT = `You scale recipe ingredient quantities for a household of ${HOUSEHOLD}. Each recipe below doesn't state its original serving size explicitly — infer a reasonable original yield from the ingredient quantities and any context in the method excerpt (most home recipes as written serve about 4 unless the quantities clearly suggest otherwise), then rewrite the ingredient list scaled proportionally for ${HOUSEHOLD} (treat the child as roughly a half portion). Keep each ingredient line in the same "quantity + item" style as the original, just with adjusted quantities — don't add or remove ingredients, don't add commentary.

Respond with ONLY a JSON array (no markdown, no commentary), one entry per recipe in the same order given: [{"id": string, "ingredients": [string, ...]}, ...]`;

function buildUserText(recipes: RecipeToScale[]): string {
  return recipes
    .map(
      (r) =>
        `id="${r.id}" title="${r.title}"\ningredients:\n${r.ingredients.map((i) => `- ${i}`).join("\n")}${r.method ? `\nmethod excerpt: ${r.method.slice(0, 300)}` : ""}`
    )
    .join("\n\n");
}

function parseJsonArrayLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : cleaned);
}

function isRawScaled(value: unknown): value is RawScaled {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && Array.isArray(v.ingredients) && v.ingredients.every((i) => typeof i === "string");
}

/** Never throws — a scaling failure (or a recipe the model dropped from its
 * response) falls back to that recipe's original, unscaled ingredient list
 * rather than blocking the email entirely. */
export async function scaleIngredientsForHousehold(dbEnv: Env, llmEnv: LlmEnv, recipes: RecipeToScale[]): Promise<Map<string, string[]>> {
  const fallback = new Map(recipes.map((r) => [r.id, r.ingredients]));
  if (recipes.length === 0) return fallback;

  try {
    const userText = buildUserText(recipes);
    const result = await routedComplete(llmEnv, "recipe ingredient scaling", SYSTEM_PROMPT, userText, 3000, "claude-haiku-4-5");
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "meal_plan_scaling",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    const parsed = parseJsonArrayLoose(result.text);
    if (!Array.isArray(parsed)) return fallback;
    for (const item of parsed) {
      if (isRawScaled(item) && fallback.has(item.id) && item.ingredients.length > 0) fallback.set(item.id, item.ingredients);
    }
    return fallback;
  } catch (error) {
    console.error("[recipes] ingredient scaling failed:", error);
    return fallback;
  }
}

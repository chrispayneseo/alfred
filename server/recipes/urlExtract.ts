// Fetches a recipe webpage and asks a cheap model to pull out the title, a
// meal-type guess, and clean recipe text — shared by the Recipe Bank's "add
// from URL" flow, Capture's recipe mode, and Chat's recipe proposal, so none
// of them re-implement fetch+extraction differently.
import { z } from "zod";
import type { Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import { MEAL_TYPES } from "../notion/schema.js";

const MAX_TEXT_CHARS = 20_000;
const MIN_TEXT_CHARS = 50;

const ExtractionSchema = z.object({
  title: z.string(),
  mealType: z.enum(MEAL_TYPES).nullable(),
  recipeText: z.string(),
});

export interface RecipeExtraction {
  title: string;
  mealType: (typeof MEAL_TYPES)[number] | null;
  recipeText: string;
  sourceUrl: string;
}

/** Crude but dependency-free HTML-to-text: strips script/style/comments and
 * every remaining tag, then collapses whitespace. Loses structure (no more
 * distinct ingredient/step lists), but recipe pages almost always keep
 * clear textual markers ("Ingredients", "Method", "Step 1"...) even as flat
 * text, and the extraction model below is doing the real structuring work —
 * this just needs to get the readable content out of the markup. */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SYSTEM_PROMPT = `You extract a recipe from a webpage's text content, which was stripped from HTML so it may be messy or contain unrelated site content mixed in — ignore anything that isn't clearly part of the recipe itself (ads, related-recipe links, comments, navigation, cookie notices).

Return:
- "title": the recipe's name.
- "mealType": your best guess at "Dinner", "Lunch", or "Breakfast" based on the recipe itself — null if genuinely unclear.
- "recipeText": a clean, readable plain-text rendition of the actual recipe — ingredients list, then method/steps, using plain line breaks (no markdown formatting, no HTML). Skip anything that isn't part of the recipe.

If the page doesn't actually contain a recipe, still do your best with "title" (describe what the page is) and leave "recipeText" as a one-line note that no recipe was found.

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"title": string, "mealType": "Dinner"|"Lunch"|"Breakfast"|null, "recipeText": string}`;

function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

/** Never throws — a fetch error, non-OK response, blocked request, or a
 * malformed model response all resolve to undefined, so every caller shows
 * a clean "couldn't read that page" rather than crashing. */
export async function extractRecipeFromUrl(dbEnv: Env, llmEnv: LlmEnv, url: string): Promise<RecipeExtraction | undefined> {
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AlfredRecipeBot/1.0; +https://alfred-five-livid.vercel.app)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    html = await res.text();
  } catch (error) {
    console.error(`[recipes] fetch failed for ${url}:`, error instanceof Error ? error.message : error);
    return undefined;
  }

  const text = stripHtmlToText(html).slice(0, MAX_TEXT_CHARS);
  if (text.length < MIN_TEXT_CHARS) return undefined;

  try {
    const result = await routedComplete(llmEnv, text, SYSTEM_PROMPT, text, 1500, "claude-haiku-4-5");
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "recipe_extraction",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    const parsed = ExtractionSchema.parse(parseJsonLoose(result.text));
    return { title: parsed.title, mealType: parsed.mealType ?? null, recipeText: parsed.recipeText, sourceUrl: url };
  } catch (error) {
    console.error(`[recipes] extraction failed for ${url}:`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

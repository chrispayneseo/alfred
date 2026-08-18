// Fetches a recipe webpage and asks a cheap model to pull out structured
// recipe data — shared by the Recipe Bank's "add from URL" flow, Capture's
// recipe mode, Chat's recipe proposal, and the bulk URL-import script, so
// none of them re-implement fetch+extraction differently.
import { z } from "zod";
import type { Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import { MEAL_TYPES } from "../notion/schema.js";

const MAX_TEXT_CHARS = 20_000;
const MIN_TEXT_CHARS = 50;

// Every field besides "isRecipe" is nullable here even though a real recipe
// always has a title/ingredients/method — models don't reliably follow
// "use an empty string/array" instructions for the isRecipe:false branch,
// where these fields are meaningless anyway (the caller discards them and
// returns { ok: false } without ever reading title/ingredients/etc.). Being
// schema-strict there just turns a correct "not a recipe" verdict into a
// crash instead of a clean skip.
const ExtractionSchema = z.object({
  isRecipe: z.boolean(),
  title: z.string().nullable(),
  cuisineType: z.string().nullable(),
  mealType: z.enum(MEAL_TYPES).nullable(),
  prepTime: z.string().nullable(),
  cookTime: z.string().nullable(),
  ingredients: z.array(z.string()).nullable(),
  method: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
});

export interface RecipeExtraction {
  title: string;
  cuisineType: string | null;
  mealType: (typeof MEAL_TYPES)[number] | null;
  prepTime: string | null;
  cookTime: string | null;
  ingredients: string[];
  method: string;
  tags: string[];
  sourceUrl: string;
}

export type ExtractionResult = { ok: true; data: RecipeExtraction } | { ok: false; reason: string };

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

const SYSTEM_PROMPT = `You extract a recipe from a webpage's text content, which was stripped from HTML so it may be messy or contain unrelated site content mixed in (ads, related-recipe links, comments, navigation, cookie notices, other articles) — ignore anything that isn't clearly part of the recipe itself.

First decide: does this page actually contain one COMPLETE specific recipe (the full ingredients list AND the full method for a single dish)? Set "isRecipe" to false — and leave the other fields null — for any of:
- A collection/listicle page or a general article, not one specific recipe.
- A PAYWALLED OR PARTIAL recipe: watch for a truncated ingredients or method list, a "sign up"/"subscribe"/"premium"/"members only"/"log in to see the rest" prompt, or the ingredients ending mid-list with no method following at all. If you can't see the complete recipe, this counts as not extractable — never fill in or guess the missing part yourself.
- A blocked, empty, or clearly non-recipe page.

If it does contain a recipe, return:
- "title": the recipe's name.
- "cuisineType": a short freeform label, e.g. "Seafood, Weeknight" or "Italian, Pasta" — comma-separated if more than one descriptor fits naturally. Null if nothing sensible fits.
- "mealType": your best guess at "Breakfast", "Lunch", "Dinner", "Snack", or "Baking" based on the dish itself — null if genuinely unclear.
- "prepTime": as stated on the page, e.g. "10 minutes" — null if not stated.
- "cookTime": as stated on the page, e.g. "15 minutes" — null if not stated.
- "ingredients": an array of ingredient lines exactly as listed (with quantities), one string per ingredient.
- "method": a CONCISE PARAPHRASED SUMMARY of the steps in your own words, a few sentences covering the key steps in order. This must be a genuine rewrite — never copy the source site's sentences verbatim.
- "tags": an array of a few short descriptive tags in your own judgment (not copied from the page), e.g. ["Quick", "30-min-or-less", "Pescatarian"].

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"isRecipe": boolean, "title": string, "cuisineType": string|null, "mealType": "Breakfast"|"Lunch"|"Dinner"|"Snack"|"Baking"|null, "prepTime": string|null, "cookTime": string|null, "ingredients": string[], "method": string, "tags": string[]}`;

function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

/** Never throws — every failure mode (fetch error, non-OK response, blocked
 * request, no readable text, malformed model response, or the page genuinely
 * not containing a recipe) resolves to `{ ok: false, reason }` rather than
 * throwing, so callers can show/log a clean reason instead of crashing. */
export async function extractRecipeFromUrl(dbEnv: Env, llmEnv: LlmEnv, url: string): Promise<ExtractionResult> {
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AlfredRecipeBot/1.0; +https://alfred-five-livid.vercel.app)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    html = await res.text();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "fetch failed" };
  }

  const text = stripHtmlToText(html).slice(0, MAX_TEXT_CHARS);
  if (text.length < MIN_TEXT_CHARS) return { ok: false, reason: "page had no readable text" };

  try {
    const result = await routedComplete(llmEnv, text, SYSTEM_PROMPT, text, 2000, "claude-haiku-4-5");
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "recipe_extraction",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    const parsed = ExtractionSchema.parse(parseJsonLoose(result.text));
    if (!parsed.isRecipe || !parsed.title || !parsed.ingredients?.length || !parsed.method) {
      return { ok: false, reason: "page doesn't contain a complete recipe (may be paywalled, a collection page, or blocked)" };
    }
    return {
      ok: true,
      data: {
        title: parsed.title,
        cuisineType: parsed.cuisineType,
        mealType: parsed.mealType,
        prepTime: parsed.prepTime,
        cookTime: parsed.cookTime,
        ingredients: parsed.ingredients,
        method: parsed.method,
        tags: parsed.tags ?? [],
        sourceUrl: url,
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "extraction failed" };
  }
}

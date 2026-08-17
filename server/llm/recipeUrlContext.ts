// Detects "add this recipe: <url>"-style messages and resolves them into a
// RecipeExtraction the way calendar/email/Notion context builders resolve
// their own data — except this one also returns the extraction itself
// (not just context text), since chat.ts attaches it directly as the
// proposal's content rather than asking the model to transcribe potentially
// large recipe text through a JSON block of its own.
import type { Env } from "../db.js";
import { extractRecipeFromUrl, type RecipeExtraction } from "../recipes/urlExtract.js";
import type { LlmEnv } from "./env.js";

const URL_RE = /https?:\/\/\S+/i;

/** Requires both a URL and the word "recipe" — a bare URL alone is too
 * ambiguous (could be a Search Console link, a freelance client site,
 * anything), and this feature only exists to save recipes, not to fetch
 * arbitrary pages. */
export function needsRecipeUrlContext(text: string): boolean {
  return URL_RE.test(text) && /recipe/i.test(text);
}

export interface RecipeUrlContextResult {
  contextText: string;
  extraction?: RecipeExtraction;
}

export async function buildRecipeUrlContext(dbEnv: Env, llmEnv: LlmEnv, text: string): Promise<RecipeUrlContextResult> {
  const match = text.match(URL_RE);
  if (!match) {
    return { contextText: "The user mentioned a recipe but didn't include a link — ask them for the URL before proposing anything." };
  }

  const extraction = await extractRecipeFromUrl(dbEnv, llmEnv, match[0]);
  if (!extraction) {
    return {
      contextText:
        "Alfred tried to read a recipe from the URL the user shared but couldn't (the page may block automated requests, or isn't a recipe page). Tell them honestly it couldn't be read — don't guess at the recipe content.",
    };
  }

  return {
    contextText: `A recipe was successfully extracted from the URL the user shared: "${extraction.title}"${extraction.mealType ? ` (looks like ${extraction.mealType})` : ""}. Alfred will show them a card to confirm adding it to the Recipe Bank — just write one short sentence confirming what was found (e.g. "Found it — ${extraction.title}. Want me to add this to your Recipe Bank?"). Don't repeat the full recipe text back to them, and don't output any special block yourself — the confirmation card is handled separately from your reply.`,
    extraction,
  };
}

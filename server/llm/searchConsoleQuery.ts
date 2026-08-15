// Resolves a natural-language Search Console question ("how did Peacock
// Search do last week?") into a precise property + date range(s) — a silent
// internal extraction call, not a user-facing proposal (unlike chat.ts's
// event/location-reminder proposals). Properties are discovered dynamically
// (server/google/searchConsole.ts), so this also does the "match a spoken
// name to the right property" work, mirroring splitCapture.ts's cheap
// Haiku-classification shape rather than chat.ts's regex-JSON-block pattern.
import { z } from "zod";
import type { Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "./env.js";
import { routedComplete } from "./routedComplete.js";

const SearchConsoleIntentSchema = z.object({
  siteMatch: z.enum(["single", "ambiguous", "none"]),
  matchedSiteUrl: z.string().nullable(),
  candidateSiteUrls: z.array(z.string()),
  startDate: z.string(),
  endDate: z.string(),
  comparisonStartDate: z.string().nullable(),
  comparisonEndDate: z.string().nullable(),
  periodLabel: z.string(),
});

export type SearchConsoleIntent = z.infer<typeof SearchConsoleIntentSchema>;

function buildSystemPrompt(todayIso: string, sites: { siteUrl: string; displayName: string }[]): string {
  const siteList = sites.map((s) => `- "${s.displayName}" (siteUrl: "${s.siteUrl}")`).join("\n");
  return `You resolve a Search Console question into a precise property and date range. Today's date is ${todayIso}.

Available Search Console properties:
${siteList}

Given the user's question:
1. Determine which property they mean, matching what they said (often just a product or site name, not the literal domain) against the properties listed above.
   - If exactly one property clearly matches — or there's only one property listed and nothing suggests otherwise — set "siteMatch" to "single" and "matchedSiteUrl" to its exact siteUrl string from the list above.
   - If more than one property could plausibly match and it's genuinely unclear which they mean, set "siteMatch" to "ambiguous" and list every plausible siteUrl in "candidateSiteUrls".
   - If nothing available matches what they're asking about at all, set "siteMatch" to "none", "matchedSiteUrl" to null, and "candidateSiteUrls" to [].
2. Resolve the date range they're asking about (e.g. "last week", "this month", "last 30 days", "yesterday") into explicit "startDate"/"endDate" (YYYY-MM-DD, both inclusive), relative to today's date above. If no period is mentioned at all, default to the trailing 7 days ending yesterday.
3. If they're asking for a comparison against an earlier period (e.g. "compare to last week", "vs last month", "how does this compare"), also resolve "comparisonStartDate"/"comparisonEndDate" for the immediately preceding period of the same length. Otherwise set both to null.
4. Set "periodLabel" to a short human-readable label for the primary period (e.g. "last 7 days", "this month so far").

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"siteMatch": "single"|"ambiguous"|"none", "matchedSiteUrl": string|null, "candidateSiteUrls": string[], "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "comparisonStartDate": string|null, "comparisonEndDate": string|null, "periodLabel": string}`;
}

function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

/** Returns undefined (rather than throwing) on any failure — the caller
 * treats that the same as "couldn't determine what was asked" and says so
 * in the injected context, never guessing. */
export async function extractSearchConsoleIntent(
  dbEnv: Env,
  llmEnv: LlmEnv,
  text: string,
  sites: { siteUrl: string; displayName: string }[],
  todayIso: string
): Promise<SearchConsoleIntent | undefined> {
  try {
    const result = await routedComplete(llmEnv, text, buildSystemPrompt(todayIso, sites), text, 400, "claude-haiku-4-5");
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "search_console_query",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    return SearchConsoleIntentSchema.parse(parseJsonLoose(result.text));
  } catch (error) {
    console.error("[searchConsoleQuery] extraction failed:", error);
    return undefined;
  }
}

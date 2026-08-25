// Fetches Leeds United's dedicated fixture page on live-footballontv.com (a
// site the user pointed at directly) and extracts the upcoming first-team
// fixtures confirmed for UK TV — same fetch+strip+extract shape as
// recipes/urlExtract.ts, chosen over an open-ended web_search because a
// single trusted page is cheaper, more reliable, and doesn't need a search
// loop. routedComplete's cross-provider fallback (Claude → ChatGPT) also
// means this keeps working if one provider is temporarily unavailable,
// unlike a direct Anthropic-only call.
import { z } from "zod";
import type { Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import { stripHtmlToText } from "../shared/htmlToText.js";
import { londonTimeToUtc } from "../shared/londonTime.js";

const SOURCE_URL = "https://www.live-footballontv.com/leeds-united-on-tv.html";
const MAX_TEXT_CHARS = 8_000;
const EXTRACT_MODEL = "claude-haiku-4-5";

export interface TvFixture {
  opponent: string;
  homeAway: "H" | "A";
  competition: string;
  channel: string;
  kickoffAt: string; // ISO
}

const FixtureSchema = z.object({
  opponent: z.string(),
  homeAway: z.enum(["H", "A"]),
  competition: z.string(),
  channel: z.string(),
  date: z.string(),
  time: z.string(),
});

const ResponseSchema = z.array(FixtureSchema);

function systemPrompt(todayIso: string): string {
  return `Today's date is ${todayIso}. You're given the text content of Leeds United's fixture-on-TV page from live-footballontv.com, stripped from HTML so it may contain unrelated site navigation/menu text mixed in — ignore anything that isn't a fixture listing.

The page lists fixtures as: a date and kickoff time, "Team A v Team B", a competition, and one or more TV channels. Extract ONLY genuine first-team senior matches — SKIP any fixture involving a youth, academy, or reserve side (anything with "U18", "U21", "U23", "Development", "Youth" in either team name, or competitions like "U18 Premier League", "National League Cup", "EFL Trophy" group stages that are clearly reserve-team fixtures for Leeds).

For each remaining fixture, determine "homeAway" as "H" if Leeds United is listed first in the "X v Y" pairing, "A" if listed second. Use the page's own date (resolving "Tuesday 25th August 2026" etc to "YYYY-MM-DD") and time (to 24h "HH:MM"). For "channel", join multiple listed channels with ", " — if the page shows something like "Sky Sports TBC", keep it as given rather than dropping the TBC.

Respond with ONLY a JSON array (no markdown fences, no commentary), each item: {"opponent": string, "homeAway": "H"|"A", "competition": string, "channel": string, "date": "YYYY-MM-DD", "time": "HH:MM"}. Only include fixtures on or after today. If none, respond with exactly: []`;
}

function parseJsonLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : cleaned);
}

/** Never throws — a fetch or extraction failure just means no fixtures for
 * now, same as "nothing confirmed for TV yet." */
export async function fetchLeedsTvFixtures(dbEnv: Env, llmEnv: LlmEnv): Promise<TvFixture[]> {
  let html: string;
  try {
    const res = await fetch(SOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AlfredLeedsTvBot/1.0; +https://alfred-five-livid.vercel.app)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[leedsTv] fetch failed: HTTP ${res.status}`);
      return [];
    }
    html = await res.text();
  } catch (error) {
    console.error("[leedsTv] fetch failed:", error);
    return [];
  }

  const text = stripHtmlToText(html).slice(0, MAX_TEXT_CHARS);
  if (text.length < 50) return [];

  const todayIso = new Date().toISOString().slice(0, 10);

  try {
    const result = await routedComplete(llmEnv, text, systemPrompt(todayIso), text, 1500, EXTRACT_MODEL);
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "leeds_tv_extraction",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    const parsed = ResponseSchema.parse(parseJsonLoose(result.text));
    const fixtures: TvFixture[] = [];
    for (const f of parsed) {
      try {
        fixtures.push({
          opponent: f.opponent,
          homeAway: f.homeAway,
          competition: f.competition,
          channel: f.channel,
          kickoffAt: londonTimeToUtc(f.date, f.time).toISOString(),
        });
      } catch {
        // unparseable date — skip this one fixture rather than the whole batch
      }
    }
    return fixtures;
  } catch (error) {
    console.error("[leedsTv] extraction failed:", error);
    return [];
  }
}

// Web-search-based lookup of Leeds United's next few fixtures that have a
// confirmed UK TV broadcaster — same direct-Anthropic-call-with-web_search
// shape as newsFeed/webSearch.ts (routedComplete's cross-provider fallback
// assumes a plain text completion, so this bypasses it same as that module).
// No domain restriction: unlike the news feed's per-topic trusted-source
// scoping, there's no user-curated domain list here, and restricting to a
// fixed guess risks the "one blocked domain 400s the whole request" issue
// found while building the news feed — simpler to let the model pick sources
// and just steer it toward official/reliable ones in the prompt.
import { getAnthropicClient } from "../llm/anthropic.js";
import { londonTimeToUtc } from "../shared/londonTime.js";

export interface TvFixture {
  opponent: string;
  homeAway: "H" | "A";
  competition: string;
  channel: string;
  kickoffAt: string; // ISO
}

export interface TvFixtureSearchOutcome {
  fixtures: TvFixture[];
  inputTokens: number;
  outputTokens: number;
}

const SEARCH_MODEL = "claude-haiku-4-5";

function searchPrompt(todayIso: string): string {
  return `Today's date is ${todayIso}. Search the web for Leeds United's next few upcoming football fixtures that have been CONFIRMED for live UK television broadcast (Sky Sports, TNT Sports, BBC, ITV, Amazon Prime Video, etc) — not fixtures that are merely scheduled but not yet picked for TV. Prefer official/reliable sources: the club's own site, Sky Sports, the Premier League/EFL fixture pages.

After searching, respond with ONLY a JSON array (no markdown fences, no commentary), each item: {"opponent": string, "homeAway": "H"|"A", "competition": string, "channel": string, "date": "YYYY-MM-DD", "time": "HH:MM" (24h, UK local kickoff time)}. Only include fixtures on or after today with a genuinely confirmed broadcaster. If you find none, respond with exactly: []`;
}

interface RawFixture {
  opponent: string;
  homeAway: string;
  competition: string;
  channel: string;
  date: string;
  time: string;
}

function isRawFixture(value: unknown): value is RawFixture {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.opponent === "string" &&
    (v.homeAway === "H" || v.homeAway === "A") &&
    typeof v.competition === "string" &&
    typeof v.channel === "string" &&
    typeof v.date === "string" &&
    typeof v.time === "string"
  );
}

// Despite the prompt asking for ONLY a JSON array, the model — especially
// after a web_search tool loop — often prefaces its answer with narration
// before the array. Extract the array substring rather than assuming the
// whole trimmed response is JSON (same issue as newsFeed/webSearch.ts).
function parseJsonLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : cleaned);
}

/** Never throws — a search failure (network, refusal, bad JSON) just means
 * no fixtures for now, same as "nothing confirmed for TV yet." */
export async function searchLeedsTvFixtures(apiKey: string): Promise<TvFixtureSearchOutcome> {
  if (!apiKey) return { fixtures: [], inputTokens: 0, outputTokens: 0 };

  const anthropic = getAnthropicClient(apiKey);
  const todayIso = new Date().toISOString().slice(0, 10);

  try {
    const response = await anthropic.messages.create({
      model: SEARCH_MODEL,
      max_tokens: 1000,
      thinking: { type: "disabled" },
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: searchPrompt(todayIso) }],
    });

    const textBlocks = response.content.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text");
    const lastText = textBlocks[textBlocks.length - 1]?.text ?? "[]";

    let fixtures: TvFixture[] = [];
    try {
      const parsed = parseJsonLoose(lastText);
      if (Array.isArray(parsed)) {
        fixtures = parsed
          .filter(isRawFixture)
          .map((f) => {
            try {
              return {
                opponent: f.opponent,
                homeAway: f.homeAway as "H" | "A",
                competition: f.competition,
                channel: f.channel,
                kickoffAt: londonTimeToUtc(f.date, f.time).toISOString(),
              };
            } catch {
              return undefined;
            }
          })
          .filter((f): f is TvFixture => f !== undefined);
      }
    } catch (error) {
      console.error("[leedsTv] couldn't parse fixture search results:", error, lastText);
    }

    return { fixtures, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  } catch (error) {
    console.error("[leedsTv] web search failed:", error);
    return { fixtures: [], inputTokens: 0, outputTokens: 0 };
  }
}

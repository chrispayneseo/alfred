// Web-search-based news gathering, one topic at a time. Calls Claude
// directly with the web_search server tool rather than going through
// routedComplete — routedComplete's cross-provider fallback assumes a plain
// text completion, and OpenAI's web-search tool has a different shape, so a
// failed search call here just skips that topic for the day rather than
// retrying on the other provider. Uses the basic (non-dynamic-filtering)
// web_search_20250305 tool type since it's the variant compatible with
// Haiku (the newer web_search_20260209 requires Opus/Sonnet-tier models).
import { getAnthropicClient } from "../llm/anthropic.js";

export interface RawSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  results: RawSearchResult[];
  inputTokens: number;
  outputTokens: number;
}

const SEARCH_MODEL = "claude-haiku-4-5";

function searchPrompt(topic: string): string {
  return `Search the web for genuinely new content about "${topic}" from roughly the last 24 hours — actual news, not evergreen or reference material. For a band/artist/club topic, look for real news (releases, tour dates, match reports, transfers) not incidental mentions. For a technical/industry topic like "AI" or "SEO", look for notable industry news, not generic listicles or SEO-spam content.

After searching, respond with ONLY a JSON array (no markdown fences, no commentary) of what you found, each item: {"title": string, "url": string, "snippet": one or two sentence description}. Only include items that are genuinely dated within the last day or two — skip anything that reads as evergreen. If you find nothing genuinely new, respond with exactly: []`;
}

function isRawSearchResult(value: unknown): value is RawSearchResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === "string" && typeof v.url === "string" && typeof v.snippet === "string";
}

// Despite the prompt asking for ONLY a JSON array, the model — especially
// after a web_search tool loop — often prefaces its answer with narration
// ("Based on my searches, I found...") before the array. Extract the
// array substring rather than assuming the whole trimmed response is JSON.
function parseJsonLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : cleaned);
}

const BLOCKED_DOMAINS_PATTERN = /domains are not accessible to our user agent: \[([^\]]*)\]/i;

/** The API 400s the *entire* request if even one allowed_domains entry is
 * inaccessible to Claude's crawler (e.g. blocks it via robots.txt) — it
 * doesn't just skip that domain. Anthropic's error message lists every
 * inaccessible domain from the request in one go. */
function parseBlockedDomains(message: string): string[] {
  const match = message.match(BLOCKED_DOMAINS_PATTERN);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function is400Error(error: unknown): error is { status: number; message?: string } {
  return typeof error === "object" && error !== null && "status" in error && (error as { status: unknown }).status === 400;
}

/** Never throws — a search failure (network, refusal, bad JSON) just means
 * zero candidates for this topic today, which the caller treats the same as
 * "nothing new happened." `domains`, when non-empty, constrains the search
 * to that topic's user-curated trusted sources (Settings) via the
 * web_search tool's allowed_domains — an open-web search otherwise. If any
 * of those domains turn out to be inaccessible to Claude's crawler, retries
 * once with just the blocked ones dropped rather than failing the topic
 * outright (falls back to the open web if none remain). */
export async function searchNewsForTopic(apiKey: string, topic: string, domains: string[] = []): Promise<WebSearchOutcome> {
  if (!apiKey) return { results: [], inputTokens: 0, outputTokens: 0 };

  const anthropic = getAnthropicClient(apiKey);
  let activeDomains = domains;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: SEARCH_MODEL,
        max_tokens: 1500,
        thinking: { type: "disabled" },
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3,
            ...(activeDomains.length > 0 ? { allowed_domains: activeDomains } : {}),
          },
        ],
        messages: [{ role: "user", content: searchPrompt(topic) }],
      });

      const textBlocks = response.content.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text");
      const lastText = textBlocks[textBlocks.length - 1]?.text ?? "[]";

      let results: RawSearchResult[] = [];
      try {
        const parsed = parseJsonLoose(lastText);
        if (Array.isArray(parsed)) results = parsed.filter(isRawSearchResult);
      } catch (error) {
        console.error(`[newsFeed] couldn't parse search results for "${topic}":`, error, lastText);
      }

      return { results, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    } catch (error) {
      if (attempt === 0 && is400Error(error)) {
        const blocked = parseBlockedDomains(error.message ?? "");
        if (blocked.length > 0) {
          const remaining = activeDomains.filter((d) => !blocked.includes(d));
          if (remaining.length !== activeDomains.length) {
            console.warn(`[newsFeed] "${topic}": dropping inaccessible domains and retrying: ${blocked.join(", ")}`);
            activeDomains = remaining;
            continue;
          }
        }
      }
      console.error(`[newsFeed] web search failed for topic "${topic}":`, error);
      return { results: [], inputTokens: 0, outputTokens: 0 };
    }
  }

  return { results: [], inputTokens: 0, outputTokens: 0 };
}

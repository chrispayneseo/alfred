// Relevance judgment + summarization for one topic's raw candidates (web
// search results + newsletter matches). Uses the routed model forced to
// Haiku, same cost-conscious pattern as project_grouping detection — this is
// high-volume, low-complexity judgment work, not something that needs a
// premium model.
import { logModelCall } from "../costTracking/callLog.js";
import type { Env } from "../db.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";

export interface Candidate {
  headline: string;
  rawSummary: string;
  sourceUrl: string;
  sourceLabel: string;
  origin: "web" | "newsletter";
}

export interface CuratedItem {
  headline: string;
  summary: string;
  sourceUrl: string;
  sourceLabel: string;
  origin: "web" | "newsletter";
  relevance: number;
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function candidateText(candidates: Candidate[]): string {
  return candidates
    .map((c, i) => `- idx:${i} source:${c.origin} headline:"${c.headline}" url:${c.sourceUrl} raw:"${c.rawSummary.slice(0, 300)}"`)
    .join("\n");
}

function curationSystemPrompt(topicName: string): string {
  const seoNote =
    topicName === "SEO"
      ? `\n\nThis topic is "SEO" specifically as industry/personal-interest news (algorithm updates, Google updates, industry commentary) — a separate app feature already reports the user's own site's search performance data, so do NOT treat routine performance-metric content as relevant here; only genuine SEO news.`
      : "";
  return `You judge genuine relevance for a personalized news feed about "${topicName}". You'll be given raw candidate items (from web search or newsletters) — judge which are genuinely notable and on-topic, not just keyword matches or incidental mentions. Drop SEO-spam-style listicles, generic marketing content, and anything only tangentially related. If two candidates cover the same story, keep only the better one.${seoNote}

Respond with ONLY a JSON array (no markdown, no commentary) of the items worth including, each: {"idx": the candidate's idx, "headline": a clean short headline, "summary": a calm one-to-two-sentence summary written for someone deciding whether to click through, "relevance": an integer 1-5, 5 being unmissable, 1 being marginal}. If nothing is genuinely worth surfacing, respond with exactly: []`;
}

interface RawCurated {
  idx: number;
  headline: string;
  summary: string;
  relevance: number;
}

function isRawCurated(value: unknown): value is RawCurated {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.idx === "number" &&
    typeof v.headline === "string" &&
    typeof v.summary === "string" &&
    typeof v.relevance === "number"
  );
}

// See webSearch.ts's parseJsonLoose — same defensive extraction, in case
// the model prefaces its JSON answer with narration.
function parseJsonLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : cleaned);
}

/** Never throws — a curation failure for one topic just means that topic
 * contributes nothing to today's feed, not a failed generation. */
export async function curateTopic(dbEnv: Env, llmEnv: LlmEnv, topicName: string, candidates: Candidate[]): Promise<CuratedItem[]> {
  if (candidates.length === 0) return [];

  try {
    const result = await routedComplete(
      llmEnv,
      `news curation ${topicName}`,
      curationSystemPrompt(topicName),
      candidateText(candidates),
      900,
      "claude-haiku-4-5"
    );
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "news_feed_curation",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    const parsed = parseJsonLoose(result.text);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(isRawCurated)
      .filter((r) => r.idx >= 0 && r.idx < candidates.length)
      .map((r): CuratedItem => {
        const candidate = candidates[r.idx];
        return {
          headline: r.headline || candidate.headline,
          summary: r.summary,
          sourceUrl: candidate.sourceUrl,
          sourceLabel: candidate.sourceLabel || domainFromUrl(candidate.sourceUrl),
          origin: candidate.origin,
          relevance: Math.max(1, Math.min(5, Math.round(r.relevance))),
        };
      });
  } catch (error) {
    console.error(`[newsFeed] curation failed for topic "${topicName}":`, error);
    return [];
  }
}

export { domainFromUrl };

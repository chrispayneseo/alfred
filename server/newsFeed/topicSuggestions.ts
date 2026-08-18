// Auto-suggested news feed topics — same shape as
// projectGroupings/projectGroupingDetection.ts: a low-frequency weekly scan
// over recent captures/notes looking for a recurring theme not already
// tracked as a topic, always surfaced as an explicit accept/dismiss
// suggestion rather than auto-added.
import { ensureSchema, getSql, type Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import type { NotionRepo } from "../notion/queries.js";
import { getSetting, setSetting } from "../settings/appSettings.js";
import { addTopic, listTopics } from "./topics.js";

const LAST_SCAN_SETTING_KEY = "news_topic_suggestion_last_scan_at";
const SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS_PER_SCAN = 2;
const MAX_CANDIDATE_ITEMS = 60;

export interface PendingTopicSuggestion {
  id: string;
  suggestedName: string;
  reason: string;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildCandidateText(tasks: { title: string }[], notes: { title: string }[]): string | undefined {
  const lines = [...tasks.slice(0, MAX_CANDIDATE_ITEMS), ...notes.slice(0, MAX_CANDIDATE_ITEMS)].map((i) => `- "${i.title}"`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function suggestionSystemPrompt(existingTopics: string[]): string {
  return `You look for a recurring interest showing up in what someone captures/notes in a personal assistant app, that isn't already one of their tracked news-feed topics. Current tracked topics: ${existingTopics.join(", ")}.

Only suggest a genuinely recurring, specific interest (something that would come up in personalized news search) — not a one-off, not something too broad ("technology"), and not anything already well covered by an existing topic.

Respond with ONLY a JSON array (no markdown, no commentary), at most 2 items, each: {"name": short topic name suitable for a news search, "reason": one calm sentence naming the pattern you noticed}. If nothing qualifies, respond with exactly: []`;
}

interface RawSuggestion {
  name: string;
  reason: string;
}

function isRawSuggestion(value: unknown): value is RawSuggestion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && v.name.trim().length > 0 && typeof v.reason === "string";
}

async function detectTopicSuggestions(dbEnv: Env, llmEnv: LlmEnv, candidateText: string, existingTopics: string[]): Promise<RawSuggestion[]> {
  let raw: string;
  try {
    const result = await routedComplete(llmEnv, "news topic suggestion detection", suggestionSystemPrompt(existingTopics), candidateText, 500, "claude-haiku-4-5");
    raw = result.text;
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "news_topic_suggestion",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  } catch (error) {
    console.error("[newsFeed] topic suggestion detection call failed:", error);
    return [];
  }

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  try {
    const parsed = JSON.parse(match ? match[0] : cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRawSuggestion).slice(0, MAX_SUGGESTIONS_PER_SCAN);
  } catch (error) {
    console.error("[newsFeed] couldn't parse topic suggestion output:", error, raw);
    return [];
  }
}

async function shouldAutoScan(env: Env): Promise<boolean> {
  const last = await getSetting(env, LAST_SCAN_SETTING_KEY);
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= SCAN_INTERVAL_MS;
}

export async function scanForTopicSuggestions(dbEnv: Env, llmEnv: LlmEnv, repo: NotionRepo): Promise<{ created: number }> {
  const [tasks, notes, existingTopics] = await Promise.all([repo.listTasks(), repo.listNotes(), listTopics(dbEnv)]);
  await setSetting(dbEnv, LAST_SCAN_SETTING_KEY, new Date().toISOString());

  const candidateText = buildCandidateText(tasks, notes);
  if (!candidateText) return { created: 0 };

  const existingNames = existingTopics.map((t) => t.name);
  const candidates = await detectTopicSuggestions(dbEnv, llmEnv, candidateText, existingNames);
  if (candidates.length === 0) return { created: 0 };

  const sql = await db(dbEnv);
  const existingSuggestionRows = (await sql.query("SELECT normalized_name FROM news_topic_suggestions")) as { normalized_name: string }[];
  const seen = new Set([...existingSuggestionRows.map((r) => r.normalized_name), ...existingNames.map(normalizeName)]);

  let created = 0;
  for (const c of candidates) {
    const norm = normalizeName(c.name);
    if (seen.has(norm)) continue;
    await sql.query(
      `INSERT INTO news_topic_suggestions (id, suggested_name, normalized_name, reason, status) VALUES ($1, $2, $3, $4, 'pending')`,
      [crypto.randomUUID(), c.name, norm, c.reason]
    );
    seen.add(norm);
    created++;
  }
  return { created };
}

export async function listPendingTopicSuggestions(dbEnv: Env): Promise<PendingTopicSuggestion[]> {
  const sql = await db(dbEnv);
  const rows = (await sql.query(
    "SELECT id, suggested_name, reason FROM news_topic_suggestions WHERE status = 'pending' ORDER BY created_at DESC"
  )) as { id: string; suggested_name: string; reason: string }[];
  return rows.map((r) => ({ id: r.id, suggestedName: r.suggested_name, reason: r.reason }));
}

/** Check-on-open entry point: auto-scans at most once a week, returns
 * whatever's currently pending. */
export async function checkTopicSuggestions(dbEnv: Env, llmEnv: LlmEnv, repo: NotionRepo): Promise<PendingTopicSuggestion[]> {
  if (await shouldAutoScan(dbEnv)) {
    await scanForTopicSuggestions(dbEnv, llmEnv, repo).catch((error) => console.error("[newsFeed] topic suggestion auto-scan failed:", error));
  }
  return listPendingTopicSuggestions(dbEnv);
}

export async function acceptTopicSuggestion(dbEnv: Env, suggestionId: string): Promise<void> {
  const sql = await db(dbEnv);
  const rows = (await sql.query("SELECT suggested_name FROM news_topic_suggestions WHERE id = $1", [suggestionId])) as {
    suggested_name: string;
  }[];
  const row = rows[0];
  if (!row) throw new Error("Suggestion not found");

  await addTopic(dbEnv, row.suggested_name);
  await sql.query("UPDATE news_topic_suggestions SET status = 'accepted' WHERE id = $1", [suggestionId]);
}

export async function dismissTopicSuggestion(dbEnv: Env, suggestionId: string): Promise<void> {
  const sql = await db(dbEnv);
  await sql.query("UPDATE news_topic_suggestions SET status = 'dismissed' WHERE id = $1", [suggestionId]);
}

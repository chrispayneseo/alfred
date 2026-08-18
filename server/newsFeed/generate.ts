// Daily generation orchestration for the personalized news feed — same
// check-on-trigger idempotency shape as server/digest/weeklyDigest.ts (no
// real cron yet; a check function is called opportunistically and decides
// via a dated row whether it's actually due). Gathers web search + newsletter
// candidates per topic, curates each topic independently, then assembles the
// day's list under the 20-item cap with a soft per-topic anti-domination
// limit rather than a rigid even split.
import { ensureSchema, getSql, type Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "../llm/env.js";
import type { NtfyEnv } from "../notify/env.js";
import { notify } from "../notify/ntfy.js";
import { curateTopic, domainFromUrl, type Candidate, type CuratedItem } from "./curate.js";
import { scanNewslettersForTopics, type NewsletterMatch } from "./newsletterScan.js";
import { listTopics } from "./topics.js";
import { searchNewsForTopic } from "./webSearch.js";

const MAX_ITEMS_PER_DAY = 20;
const MAX_ITEMS_PER_TOPIC = 6;
const DEDUP_LOOKBACK_DAYS = 14;
const SEARCH_MODEL_ID = "claude-haiku-4-5";

export interface NewsFeedItem {
  id: string;
  topicName: string;
  headline: string;
  summary: string;
  sourceUrl: string;
  sourceLabel: string;
  origin: "web" | "newsletter";
}

export interface NewsFeedResult {
  dateKey: string;
  items: NewsFeedItem[];
  generatedAt: string;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ItemRow {
  id: string;
  topic_name: string;
  headline: string;
  summary: string;
  source_url: string;
  source_label: string | null;
  origin: string;
}

function toItem(row: ItemRow): NewsFeedItem {
  return {
    id: row.id,
    topicName: row.topic_name,
    headline: row.headline,
    summary: row.summary,
    sourceUrl: row.source_url,
    sourceLabel: row.source_label ?? domainFromUrl(row.source_url),
    origin: row.origin === "newsletter" ? "newsletter" : "web",
  };
}

async function getCached(env: Env, dateKey: string): Promise<NewsFeedResult | undefined> {
  const sql = await db(env);
  const genRows = (await sql.query("SELECT generated_at FROM news_feed_generations WHERE date_key = $1", [dateKey])) as {
    generated_at: string;
  }[];
  if (genRows.length === 0) return undefined;

  const itemRows = (await sql.query(
    "SELECT id, topic_name, headline, summary, source_url, source_label, origin FROM news_feed_items WHERE date_key = $1 ORDER BY topic_name ASC, created_at ASC",
    [dateKey]
  )) as ItemRow[];

  return { dateKey, items: itemRows.map(toItem), generatedAt: new Date(genRows[0].generated_at).toISOString() };
}

/** Source URLs already surfaced within the lookback window — a hard
 * pre-filter so the same story doesn't resurface, applied before curation
 * so no tokens are spent re-judging something already shown. */
async function getRecentSourceUrls(env: Env, days: number): Promise<Set<string>> {
  const sql = await db(env);
  const rows = (await sql.query(
    `SELECT DISTINCT source_url FROM news_feed_items WHERE created_at >= now() - ($1 || ' days')::interval`,
    [String(days)]
  )) as { source_url: string }[];
  return new Set(rows.map((r) => r.source_url));
}

/** Generates immediately regardless of whether today's feed already exists —
 * overwriting is harmless since it's gated by date_key, same "generate now"
 * shape as the weekly digest's manual trigger. */
export async function generateNewsFeedNow(dbEnv: Env, llmEnv: LlmEnv, ntfyEnv: NtfyEnv): Promise<NewsFeedResult> {
  const dateKey = todayKey();
  const topics = await listTopics(dbEnv);
  const recentUrls = await getRecentSourceUrls(dbEnv, DEDUP_LOOKBACK_DAYS);

  const newsletterMatches: NewsletterMatch[] =
    topics.length > 0 ? await scanNewslettersForTopics(dbEnv, llmEnv, topics.map((t) => t.name)) : [];
  const newsletterByTopic = new Map<string, NewsletterMatch[]>();
  for (const match of newsletterMatches) {
    const list = newsletterByTopic.get(match.topicName) ?? [];
    list.push(match);
    newsletterByTopic.set(match.topicName, list);
  }

  const perTopicCurated: { topicName: string; items: CuratedItem[] }[] = [];

  for (const topic of topics) {
    const webOutcome = await searchNewsForTopic(llmEnv.anthropicApiKey, topic.name);
    if (webOutcome.inputTokens > 0 || webOutcome.outputTokens > 0) {
      await logModelCall(dbEnv, {
        provider: "claude",
        feature: "news_feed_search",
        model: SEARCH_MODEL_ID,
        inputTokens: webOutcome.inputTokens,
        outputTokens: webOutcome.outputTokens,
      });
    }

    const webCandidates: Candidate[] = webOutcome.results
      .filter((r) => !recentUrls.has(r.url))
      .map((r) => ({ headline: r.title, rawSummary: r.snippet, sourceUrl: r.url, sourceLabel: domainFromUrl(r.url), origin: "web" }));

    const newsletterCandidates: Candidate[] = (newsletterByTopic.get(topic.name) ?? [])
      .filter((m) => !recentUrls.has(m.sourceUrl))
      .map((m) => ({ headline: m.headline, rawSummary: m.summary, sourceUrl: m.sourceUrl, sourceLabel: m.sourceLabel, origin: "newsletter" }));

    const candidates = [...webCandidates, ...newsletterCandidates];
    if (candidates.length === 0) continue;

    const curated = await curateTopic(dbEnv, llmEnv, topic.name, candidates);
    if (curated.length > 0) perTopicCurated.push({ topicName: topic.name, items: curated });
  }

  // Global relevance ranking with a soft per-topic cap — lets a topic with
  // genuinely rich news take more of the day's 20 slots than a quiet one,
  // without letting any single topic take all of them.
  const allRanked = perTopicCurated
    .flatMap(({ topicName, items }) => items.map((item) => ({ ...item, topicName })))
    .sort((a, b) => b.relevance - a.relevance);

  const perTopicCount = new Map<string, number>();
  const finalItems: NewsFeedItem[] = [];
  for (const item of allRanked) {
    if (finalItems.length >= MAX_ITEMS_PER_DAY) break;
    const count = perTopicCount.get(item.topicName) ?? 0;
    if (count >= MAX_ITEMS_PER_TOPIC) continue;
    finalItems.push({
      id: crypto.randomUUID(),
      topicName: item.topicName,
      headline: item.headline,
      summary: item.summary,
      sourceUrl: item.sourceUrl,
      sourceLabel: item.sourceLabel,
      origin: item.origin,
    });
    perTopicCount.set(item.topicName, count + 1);
  }

  const sql = await db(dbEnv);
  // Regeneration (manual, or a duplicate concurrent check-on-trigger call)
  // must replace the day's items, not accumulate alongside them.
  await sql.query("DELETE FROM news_feed_items WHERE date_key = $1", [dateKey]);
  for (const item of finalItems) {
    await sql.query(
      `INSERT INTO news_feed_items (id, date_key, topic_name, headline, summary, source_url, source_label, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [item.id, dateKey, item.topicName, item.headline, item.summary, item.sourceUrl, item.sourceLabel, item.origin]
    );
  }
  await sql.query(`INSERT INTO news_feed_generations (date_key) VALUES ($1) ON CONFLICT (date_key) DO UPDATE SET generated_at = now()`, [
    dateKey,
  ]);

  if (ntfyEnv.topic && finalItems.length > 0) {
    const count = finalItems.length;
    await notify(ntfyEnv.topic, `${count} new ${count === 1 ? "story" : "stories"} in your feed.`, "Your feed is ready").catch((error) =>
      console.error("[newsFeed] ntfy push failed:", error)
    );
  }

  return { dateKey, items: finalItems, generatedAt: new Date().toISOString() };
}

/** Check-on-open entry point: returns today's cached feed if it already
 * exists, generates it otherwise. */
export async function checkNewsFeed(dbEnv: Env, llmEnv: LlmEnv, ntfyEnv: NtfyEnv): Promise<NewsFeedResult> {
  const dateKey = todayKey();
  const cached = await getCached(dbEnv, dateKey);
  if (cached) return cached;
  return generateNewsFeedNow(dbEnv, llmEnv, ntfyEnv);
}

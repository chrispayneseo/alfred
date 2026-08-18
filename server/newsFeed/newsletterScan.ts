// Newsletter/subscription content discovery for the news feed — distinct
// from server/llm/emailScan.ts's action-item scanning: this looks at the
// same synced Gmail metadata (both connected accounts) for newsletter-style
// content that matches a tracked topic, tracked via its own
// news_feed_scanned_emails table so it never re-examines the same message
// twice, independent of emailScan's own `scanned` flag on gmail_emails.
import { ensureSchema, getSql, type Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import { gmailThreadUrl } from "../google/gmail.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";

const NEWSLETTER_SENDER_PATTERN =
  /(newsletter|digest|weekly|no-?reply|do-?not-?reply|notifications?|mailer|updates?|hello|team)@|@(substack\.com|mailchimp|beehiiv\.com|convertkit|buttondown|revue|getrevue|campaign-archive)/i;

const SCAN_LIMIT = 80;
const MAX_CANDIDATES_FOR_LLM = 40;

interface CandidateEmailRow {
  row_key: string;
  account_email: string;
  thread_id: string;
  sender: string;
  sender_email: string;
  subject: string;
  snippet: string;
}

export interface NewsletterMatch {
  rowKey: string;
  topicName: string;
  headline: string;
  summary: string;
  sourceUrl: string;
  sourceLabel: string;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

function looksLikeNewsletter(email: { sender_email: string }): boolean {
  return NEWSLETTER_SENDER_PATTERN.test(email.sender_email);
}

function buildCandidateText(rows: CandidateEmailRow[]): string {
  return rows
    .map((r, i) => `- rowKey:${r.row_key} idx:${i} sender:"${r.sender}" subject:"${r.subject}" snippet:"${r.snippet.slice(0, 200)}"`)
    .join("\n");
}

function matchSystemPrompt(topics: string[]): string {
  return `You scan newsletter-style emails for a personal news feed app and match each one against the person's tracked topics: ${topics.join(", ")}.

For each email, decide if its content is genuinely about one of these topics — not just a passing mention. A generic marketing email or an unrelated newsletter doesn't match anything. Given SEO is one of the topics, only match SEO content that's genuinely newsy (algorithm updates, industry news) — not routine product marketing.

Respond with ONLY a JSON array (no markdown, no commentary) of the genuine matches, each: {"rowKey": string (from the list), "topic": the exact matching topic name, "headline": a short headline for this content (under 12 words), "summary": one or two sentence summary of the relevant content}. Omit anything that doesn't clearly match a topic. If nothing matches, respond with exactly: []`;
}

interface RawMatch {
  rowKey: string;
  topic: string;
  headline: string;
  summary: string;
}

function isRawMatch(value: unknown): value is RawMatch {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.rowKey === "string" && typeof v.topic === "string" && typeof v.headline === "string" && typeof v.summary === "string";
}

// See webSearch.ts's parseJsonLoose — same defensive extraction, in case
// the model prefaces its JSON answer with narration.
function parseJsonLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  return JSON.parse(match ? match[0] : cleaned);
}

async function markScanned(env: Env, rowKeys: string[]): Promise<void> {
  if (rowKeys.length === 0) return;
  const sql = await db(env);
  for (const rowKey of rowKeys) {
    await sql.query("INSERT INTO news_feed_scanned_emails (row_key) VALUES ($1) ON CONFLICT (row_key) DO NOTHING", [rowKey]);
  }
}

/** Scans a batch of not-yet-newsletter-scanned emails (both accounts) for
 * content matching a tracked topic. Marks the whole fetched batch scanned
 * regardless of outcome, so a batch with no newsletters in it doesn't get
 * re-fetched on the next generation. Never throws — a failure here should
 * never block the rest of the day's feed generation. */
export async function scanNewslettersForTopics(dbEnv: Env, llmEnv: LlmEnv, topicNames: string[]): Promise<NewsletterMatch[]> {
  if (topicNames.length === 0) return [];

  try {
    const sql = await db(dbEnv);
    const rows = (await sql.query(
      `SELECT g.row_key, g.account_email, g.thread_id, g.sender, g.sender_email, g.subject, g.snippet
       FROM gmail_emails g
       LEFT JOIN news_feed_scanned_emails s ON s.row_key = g.row_key
       WHERE s.row_key IS NULL
       ORDER BY g.date DESC
       LIMIT $1`,
      [SCAN_LIMIT]
    )) as CandidateEmailRow[];

    if (rows.length === 0) return [];

    const candidates = rows.filter(looksLikeNewsletter).slice(0, MAX_CANDIDATES_FOR_LLM);
    if (candidates.length === 0) {
      await markScanned(dbEnv, rows.map((r) => r.row_key));
      return [];
    }

    const rowByKey = new Map(candidates.map((r) => [r.row_key, r]));
    const candidateText = buildCandidateText(candidates);

    let raw: RawMatch[] = [];
    try {
      const result = await routedComplete(llmEnv, "newsletter topic matching", matchSystemPrompt(topicNames), candidateText, 800, "claude-haiku-4-5");
      await logModelCall(dbEnv, {
        provider: result.model,
        feature: "news_feed_newsletter_scan",
        model: result.modelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      const parsed = parseJsonLoose(result.text);
      if (Array.isArray(parsed)) raw = parsed.filter(isRawMatch);
    } catch (error) {
      console.error("[newsFeed] newsletter match call failed:", error);
    }

    const topicSet = new Set(topicNames);
    const matches: NewsletterMatch[] = raw
      .filter((m) => rowByKey.has(m.rowKey) && topicSet.has(m.topic))
      .map((m) => {
        const email = rowByKey.get(m.rowKey)!;
        return {
          rowKey: m.rowKey,
          topicName: m.topic,
          headline: m.headline,
          summary: m.summary,
          sourceUrl: gmailThreadUrl(email.thread_id, email.account_email),
          sourceLabel: email.sender,
        };
      });

    await markScanned(dbEnv, rows.map((r) => r.row_key));
    return matches;
  } catch (error) {
    console.error("[newsFeed] newsletter scan failed:", error);
    return [];
  }
}

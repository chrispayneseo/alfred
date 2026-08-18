import { ensureSchema, getSql, type Env } from "../db.js";

export type ModelProvider = "claude" | "chatgpt";

export type ModelFeature =
  | "chat"
  | "capture"
  | "gmail_scan_classify"
  | "gmail_scan_reply"
  | "photo_extraction"
  | "nudges"
  | "digest"
  | "recurring_detection"
  | "project_grouping"
  | "search_console_query"
  | "recipe_extraction"
  | "recipe_weather_ranking"
  | "evie_scan_classify"
  | "news_feed_search"
  | "news_feed_curation"
  | "news_feed_newsletter_scan"
  | "news_topic_suggestion"
  | "leeds_ticket_extraction";

export interface CallLogEntry {
  provider: ModelProvider;
  feature: ModelFeature;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Best-effort — a logging failure must never break the feature that made
 * the actual LLM call, so this swallows its own errors after logging them. */
export async function logModelCall(env: Env, entry: CallLogEntry): Promise<void> {
  try {
    await ensureSchema(env);
    const sql = getSql(env);
    await sql.query(
      `INSERT INTO llm_call_log (provider, feature, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5)`,
      [entry.provider, entry.feature, entry.model, entry.inputTokens, entry.outputTokens]
    );
  } catch (error) {
    console.error("[costTracking] failed to log model call:", error);
  }
}

export interface FeatureShare {
  feature: ModelFeature;
  provider: ModelProvider;
  inputTokens: number;
  outputTokens: number;
}

/** Every feature/provider's token totals since `since` — the dashboard
 * scales these proportionally against each provider's real dollar spend
 * from the Admin API, since token volume (not dollars) is what this table
 * tracks. Estimate, not exact — clearly labeled as such in the UI. */
export async function getFeatureShares(env: Env, since: Date): Promise<FeatureShare[]> {
  await ensureSchema(env);
  const sql = getSql(env);
  const rows = (await sql.query(
    `SELECT provider, feature, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
     FROM llm_call_log
     WHERE created_at >= $1
     GROUP BY provider, feature`,
    [since.toISOString()]
  )) as { provider: ModelProvider; feature: ModelFeature; input_tokens: string; output_tokens: string }[];
  return rows.map((r) => ({
    provider: r.provider,
    feature: r.feature,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
  }));
}

/** True if an alert for this provider was already sent this billing cycle —
 * lets the cron check run every 30 minutes without re-notifying. */
export async function wasAlertSent(env: Env, provider: ModelProvider, monthKey: string): Promise<boolean> {
  await ensureSchema(env);
  const sql = getSql(env);
  const rows = await sql.query(`SELECT 1 FROM cost_alerts_sent WHERE provider = $1 AND month_key = $2`, [provider, monthKey]);
  return rows.length > 0;
}

export async function markAlertSent(env: Env, provider: ModelProvider, monthKey: string): Promise<void> {
  await ensureSchema(env);
  const sql = getSql(env);
  await sql.query(`INSERT INTO cost_alerts_sent (provider, month_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [provider, monthKey]);
}

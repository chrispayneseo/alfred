// Shared Postgres access (Neon, provisioned via Vercel's Marketplace) — the
// persistent store behind everything that used to live in local SQLite or a
// hand-written .env file: Google OAuth tokens, the Gmail metadata cache,
// nudge push-history, and the sync/scan job status. One database for both
// local dev and production (same DATABASE_URL in both places), replacing
// server/google/gmailStore.ts and server/nudges/nudgeStore.ts's node:sqlite
// usage and server/google/accounts.ts's .env-JSON storage — none of which
// survive Vercel's ephemeral, stateless serverless filesystem.
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type Env = Record<string, string | undefined>;

let cachedSql: NeonQueryFunction<false, false> | undefined;
let cachedConnectionString: string | undefined;

function getConnectionString(env: Env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL isn't configured.");
  return url;
}

/** The Neon HTTP query client — one query per request, no connection-pool
 * exhaustion risk under serverless concurrency (unlike a raw TCP pool would
 * have). Memoized per connection string so repeated calls within one
 * invocation (or across a long-lived local dev process) reuse it. */
export function getSql(env: Env): NeonQueryFunction<false, false> {
  const connectionString = getConnectionString(env);
  if (!cachedSql || cachedConnectionString !== connectionString) {
    cachedSql = neon(connectionString);
    cachedConnectionString = connectionString;
  }
  return cachedSql;
}

// The Neon HTTP driver runs one statement per call (no multi-statement
// strings over HTTP), so schema setup is a list of individual statements
// rather than one exec() block like the old node:sqlite version had.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS google_accounts (
    email TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    health TEXT NOT NULL DEFAULT 'ok',
    connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS gmail_emails (
    row_key TEXT PRIMARY KEY,
    account_email TEXT NOT NULL,
    id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    snippet TEXT NOT NULL,
    scanned BOOLEAN NOT NULL DEFAULT false,
    actionable BOOLEAN NOT NULL DEFAULT false,
    needs_reply BOOLEAN NOT NULL DEFAULT false,
    has_deadline BOOLEAN NOT NULL DEFAULT false,
    deadline_date TEXT,
    project TEXT,
    item_type TEXT,
    notion_page_id TEXT,
    draft_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gmail_emails_scanned ON gmail_emails(scanned)`,
  `CREATE INDEX IF NOT EXISTS idx_gmail_emails_actionable ON gmail_emails(actionable)`,
  `CREATE INDEX IF NOT EXISTS idx_gmail_emails_account ON gmail_emails(account_email)`,
  `CREATE TABLE IF NOT EXISTS gmail_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pushed_nudges (task_id TEXT PRIMARY KEY, pushed_date TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS snoozed_nudges (task_id TEXT PRIMARY KEY, snoozed_until TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS weekly_digest (
    week_key TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS recurring_suggestions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    cadence TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recurring_suggestions_status ON recurring_suggestions(status)`,
  `CREATE TABLE IF NOT EXISTS recurring_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cadence TEXT NOT NULL,
    cadence_days INT NOT NULL,
    project_id TEXT,
    client TEXT,
    current_task_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS project_grouping_suggestions (
    id TEXT PRIMARY KEY,
    suggested_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    items TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_grouping_suggestions_status ON project_grouping_suggestions(status)`,
  `CREATE TABLE IF NOT EXISTS sync_job (
    id TEXT PRIMARY KEY DEFAULT 'singleton',
    running BOOLEAN NOT NULL DEFAULT false,
    processed INT NOT NULL DEFAULT 0,
    total INT,
    error TEXT,
    last_sync_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS scan_job (
    id TEXT PRIMARY KEY DEFAULT 'singleton',
    running BOOLEAN NOT NULL DEFAULT false,
    processed INT NOT NULL DEFAULT 0,
    total INT NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `INSERT INTO sync_job (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO scan_job (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING`,
  // Neither Anthropic's nor OpenAI's Admin/Cost APIs can attribute spend to
  // Alfred's own feature categories (Chat, Capture, Gmail scan, ...) — they
  // only group by model/workspace/api key. This table is Alfred's own
  // record of every LLM call, used to compute the proportion of each
  // provider's real dollar spend attributable to each feature.
  `CREATE TABLE IF NOT EXISTS llm_call_log (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    feature TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INT NOT NULL,
    output_tokens INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_llm_call_log_created_at ON llm_call_log(created_at)`,
  // One row per provider per billing-cycle-crossed-threshold, so the
  // proactive cost alert fires once per threshold per month, not every
  // 30 minutes the cron happens to notice it's still over.
  `CREATE TABLE IF NOT EXISTS cost_alerts_sent (
    provider TEXT NOT NULL,
    month_key TEXT NOT NULL,
    PRIMARY KEY (provider, month_key)
  )`,
  // Append-only log of every recipe included in a sent email (scheduled or
  // on-demand) — the weekly selection sorts by MAX(sent_at) per recipe_id
  // (least-recently-sent first) to avoid repeats without needing a separate
  // "have enough recipes?" check; it degrades to repeats naturally once a
  // meal type's pool is smaller than the number needed.
  `CREATE TABLE IF NOT EXISTS recipe_sends (
    recipe_id TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_sends_recipe_id ON recipe_sends(recipe_id)`,
  // One row per ISO week the automatic Sunday-noon email actually sent —
  // gates the scheduled check so repeated cron pings after the first send
  // that week don't send again. The on-demand button bypasses this table
  // entirely (it always sends), so it never blocks on it either.
  `CREATE TABLE IF NOT EXISTS recipe_email_weekly_log (
    week_key TEXT PRIMARY KEY,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Evie (school email monitor): which gmail_emails rows have already been
  // checked against the narrow sender+keyword filter, independent of
  // Alfred's general `scanned` flag on gmail_emails (a different concern —
  // that one drives the Notion-filing classifier, this one drives Evie).
  `CREATE TABLE IF NOT EXISTS evie_scanned_messages (
    row_key TEXT PRIMARY KEY,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Background-job-generated, reviewed later — same lifecycle shape as
  // recurring_suggestions, not Chat's ephemeral in-React-state proposals
  // (those are tied to one live message; these need to survive a refresh).
  // Accepting one calls the same /api/calendar/create-event Chat's proposal
  // card uses, then flips status here.
  `CREATE TABLE IF NOT EXISTS evie_event_proposals (
    id TEXT PRIMARY KEY,
    gmail_row_key TEXT NOT NULL,
    account_email TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evie_event_proposals_status ON evie_event_proposals(status)`,
  // Non-event action items (permission slips, payments, replies) detected by
  // the same check — pushed once via ntfy at insert time (no separate
  // throttle table needed, see check.ts), shown on Today until resolved.
  `CREATE TABLE IF NOT EXISTS evie_action_items (
    id TEXT PRIMARY KEY,
    gmail_row_key TEXT NOT NULL,
    account_email TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    summary TEXT NOT NULL,
    reason TEXT NOT NULL,
    due_date TEXT,
    resolved BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evie_action_items_resolved ON evie_action_items(resolved)`,
];

let schemaReady: Promise<void> | undefined;

async function runMigrations(env: Env): Promise<void> {
  const sql = getSql(env);
  for (const statement of SCHEMA_STATEMENTS) {
    await sql.query(statement);
  }
}

/** Idempotent — safe to call on every cold start. Memoized so a long-lived
 * local dev process (or a warm serverless instance serving several requests)
 * only actually runs the migration once. */
export function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) schemaReady = runMigrations(env);
  return schemaReady;
}

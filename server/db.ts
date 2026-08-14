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

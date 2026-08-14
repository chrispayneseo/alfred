import { getMessageMetadata, listInboxMessageIds } from "./gmail.js";
import { markAccountNeedsReconnect, markAccountOk, type GoogleAccountEnv } from "./accounts.js";
import { GoogleReconnectRequiredError, toGoogleErrorCode } from "./errors.js";
import { countTotal, setMeta, upsertEmailMetadata } from "./gmailStore.js";
import { ensureSchema, getSql, type Env } from "../db.js";

export interface SyncStatus {
  running: boolean;
  processed: number;
  total?: number;
  error?: string;
  lastSyncAt?: string;
}

interface SyncJobRow {
  running: boolean;
  processed: number;
  total: number | null;
  error: string | null;
  last_sync_at: string | null;
  updated_at: string;
}

const BATCH_SIZE = 10;
const BATCH_PACING_MS = 200;
// If a job has been "running" this long with no progress update, treat it as
// dead (e.g. the serverless instance running it was recycled mid-job) rather
// than leaving the UI on an infinite spinner forever — nothing else would
// ever clear a stuck row, unlike the old in-memory version where a process
// restart reset it for free.
const STALE_AFTER_MS = 6 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

function toStatus(row: SyncJobRow): SyncStatus {
  return {
    running: row.running,
    processed: row.processed,
    total: row.total ?? undefined,
    error: row.error ?? undefined,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : undefined,
  };
}

export async function getSyncStatus(env: Env): Promise<SyncStatus> {
  const sql = await db(env);
  const [row] = (await sql.query("SELECT * FROM sync_job WHERE id = 'singleton'")) as SyncJobRow[];
  if (row.running && Date.now() - new Date(row.updated_at).getTime() > STALE_AFTER_MS) {
    const [updated] = (await sql.query(
      "UPDATE sync_job SET running = false, error = 'timeout', updated_at = now() WHERE id = 'singleton' RETURNING *"
    )) as SyncJobRow[];
    return toStatus(updated);
  }
  return toStatus(row);
}

/** Paginates the inbox since `days` ago across every connected account,
 * fetching metadata in small paced batches so a 30–90 day backfill doesn't
 * hammer Gmail's rate limits. Claimed atomically against sync_job (an
 * UPDATE ... WHERE running = false) so two concurrent "start" requests, or
 * two different serverless instances, can't both run it at once.
 * `backgroundTask` lets the actual work keep going after this function
 * returns — fire-and-forget locally, Vercel's waitUntil in production (see
 * the adapters in server/apiPlugin.ts and api/[...path].ts). Call
 * getSyncStatus() to poll progress. One account needing reconnection
 * doesn't stop the others from syncing; only reported as a job-level error
 * if every account fails. */
export async function startSync(
  env: Env,
  accounts: GoogleAccountEnv[],
  days: number,
  backgroundTask: (task: Promise<unknown>) => void
): Promise<SyncStatus> {
  const sql = await db(env);
  const claimed = (await sql.query(
    `UPDATE sync_job SET running = true, processed = 0, total = NULL, error = NULL, updated_at = now()
     WHERE id = 'singleton' AND running = false
     RETURNING *`
  )) as SyncJobRow[];
  if (claimed.length === 0) return getSyncStatus(env);

  backgroundTask(
    runSync(env, accounts, days).catch(async (error) => {
      console.error("[gmailSync] sync failed:", error);
      await sql.query("UPDATE sync_job SET running = false, error = $1, updated_at = now() WHERE id = 'singleton'", [
        toGoogleErrorCode(error),
      ]);
    })
  );

  return toStatus(claimed[0]);
}

async function runSync(env: Env, accounts: GoogleAccountEnv[], days: number): Promise<void> {
  const sql = await db(env);
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - days);

  const failedAccounts: string[] = [];

  for (const account of accounts) {
    try {
      await syncAccount(env, account, afterDate);
      await markAccountOk(env, account.email);
    } catch (error) {
      console.error(`[gmailSync] account ${account.email} failed:`, error);
      if (error instanceof GoogleReconnectRequiredError) await markAccountNeedsReconnect(env, account.email);
      failedAccounts.push(account.email);
    }
  }

  const lastSyncAt = new Date().toISOString();
  await setMeta(env, "lastSyncAt", lastSyncAt);
  const total = await countTotal(env);
  // Only surface a job-level error if literally every account failed —
  // otherwise the accounts that did sync stay visible and the broken one is
  // just reflected in its own account health (see Settings).
  const allFailed = accounts.length > 0 && failedAccounts.length === accounts.length;
  await sql.query(
    "UPDATE sync_job SET running = false, total = $1, last_sync_at = $2, error = $3, updated_at = now() WHERE id = 'singleton'",
    [total, lastSyncAt, allFailed ? "reconnect_required" : null]
  );
}

async function syncAccount(env: Env, account: GoogleAccountEnv, afterDate: Date): Promise<void> {
  const sql = await db(env);
  let pageToken: string | undefined;
  let first = true;

  do {
    const { refs, nextPageToken, resultSizeEstimate } = await listInboxMessageIds(account, {
      afterDate,
      pageToken,
      pageSize: 50,
    });
    if (first && resultSizeEstimate) {
      await sql.query("UPDATE sync_job SET total = COALESCE(total, 0) + $1, updated_at = now() WHERE id = 'singleton'", [
        resultSizeEstimate,
      ]);
    }
    first = false;

    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
      const batch = refs.slice(i, i + BATCH_SIZE);
      const metadata = await Promise.all(batch.map((ref) => getMessageMetadata(account, ref.id)));
      await upsertEmailMetadata(env, metadata);
      await sql.query("UPDATE sync_job SET processed = processed + $1, updated_at = now() WHERE id = 'singleton'", [
        batch.length,
      ]);
      await sleep(BATCH_PACING_MS);
    }

    pageToken = nextPageToken;
  } while (pageToken);
}

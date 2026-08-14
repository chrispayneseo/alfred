import { getMessageMetadata, listInboxMessageIds } from "./gmail";
import type { GoogleAccountEnv } from "./accounts";
import { markAccountNeedsReconnect, markAccountOk } from "./accountStatus";
import { GoogleReconnectRequiredError, toGoogleErrorCode } from "./errors";
import { countTotal, setMeta, upsertEmailMetadata } from "./gmailStore";

export interface SyncStatus {
  running: boolean;
  processed: number;
  total?: number;
  error?: string;
  lastSyncAt?: string;
}

// Single in-memory job — this dev process is the only writer, no queue needed.
let job: SyncStatus = { running: false, processed: 0 };

const BATCH_SIZE = 10;
const BATCH_PACING_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getSyncStatus(): SyncStatus {
  return { ...job };
}

/** Paginates the inbox since `days` ago across every connected account,
 * fetching metadata in small paced batches so a 30–90 day backfill doesn't
 * hammer Gmail's rate limits. Runs in the background — call getSyncStatus()
 * to poll progress. One account needing reconnection doesn't stop the
 * others from syncing; only reported as an error if every account fails. */
export function startSync(accounts: GoogleAccountEnv[], days: number): SyncStatus {
  if (job.running) return getSyncStatus();
  job = { running: true, processed: 0 };

  void runSync(accounts, days).catch((error) => {
    console.error("[gmailSync] sync failed:", error);
    job = { ...job, running: false, error: toGoogleErrorCode(error) };
  });

  return getSyncStatus();
}

async function runSync(accounts: GoogleAccountEnv[], days: number): Promise<void> {
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - days);

  const failedAccounts: string[] = [];

  for (const account of accounts) {
    try {
      await syncAccount(account, afterDate);
      markAccountOk(account.email);
    } catch (error) {
      console.error(`[gmailSync] account ${account.email} failed:`, error);
      if (error instanceof GoogleReconnectRequiredError) markAccountNeedsReconnect(account.email);
      failedAccounts.push(account.email);
    }
  }

  const lastSyncAt = new Date().toISOString();
  setMeta("lastSyncAt", lastSyncAt);
  // Only surface a job-level error if literally every account failed —
  // otherwise the accounts that did sync stay visible and the broken one is
  // just reflected in its own account status (see Settings).
  const allFailed = accounts.length > 0 && failedAccounts.length === accounts.length;
  job = {
    running: false,
    processed: job.processed,
    total: countTotal(),
    lastSyncAt,
    error: allFailed ? "reconnect_required" : undefined,
  };
}

async function syncAccount(account: GoogleAccountEnv, afterDate: Date): Promise<void> {
  let pageToken: string | undefined;
  let first = true;

  do {
    const { refs, nextPageToken, resultSizeEstimate } = await listInboxMessageIds(account, {
      afterDate,
      pageToken,
      pageSize: 50,
    });
    if (first && resultSizeEstimate) job = { ...job, total: (job.total ?? 0) + resultSizeEstimate };
    first = false;

    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
      const batch = refs.slice(i, i + BATCH_SIZE);
      const metadata = await Promise.all(batch.map((ref) => getMessageMetadata(account, ref.id)));
      upsertEmailMetadata(metadata);
      job = { ...job, processed: job.processed + batch.length };
      await sleep(BATCH_PACING_MS);
    }

    pageToken = nextPageToken;
  } while (pageToken);
}

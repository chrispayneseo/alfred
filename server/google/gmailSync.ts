import { getMessageMetadata, listInboxMessageIds } from "./gmail";
import type { GoogleEnv } from "./env";
import { toGoogleErrorCode } from "./errors";
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

/** Paginates the inbox since `days` ago, fetching metadata in small paced
 * batches so a 30–90 day backfill doesn't hammer Gmail's rate limits. Runs in
 * the background — call getSyncStatus() to poll progress. */
export function startSync(env: GoogleEnv, days: number): SyncStatus {
  if (job.running) return getSyncStatus();
  job = { running: true, processed: 0 };

  void runSync(env, days).catch((error) => {
    console.error("[gmailSync] sync failed:", error);
    job = { ...job, running: false, error: toGoogleErrorCode(error) };
  });

  return getSyncStatus();
}

async function runSync(env: GoogleEnv, days: number): Promise<void> {
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - days);

  let pageToken: string | undefined;
  let first = true;

  do {
    const { refs, nextPageToken, resultSizeEstimate } = await listInboxMessageIds(env, {
      afterDate,
      pageToken,
      pageSize: 50,
    });
    if (first && resultSizeEstimate) job = { ...job, total: resultSizeEstimate };
    first = false;

    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
      const batch = refs.slice(i, i + BATCH_SIZE);
      const metadata = await Promise.all(batch.map((ref) => getMessageMetadata(env, ref.id)));
      upsertEmailMetadata(metadata);
      job = { ...job, processed: job.processed + batch.length };
      await sleep(BATCH_PACING_MS);
    }

    pageToken = nextPageToken;
  } while (pageToken);

  const lastSyncAt = new Date().toISOString();
  setMeta("lastSyncAt", lastSyncAt);
  job = { running: false, processed: job.processed, total: countTotal(), lastSyncAt };
}

import type { Env } from "../db.js";
import { clearAllWeeklyDigests } from "../digest/weeklyDigest.js";
import { removeAllAccounts, type GoogleAccountEnv } from "../google/accounts.js";
import { clearAllEmails } from "../google/gmailStore.js";
import { revokeToken } from "../google/oauth.js";
import { clearAllPushedNudges, clearAllSnoozedNudges } from "../nudges/nudgeStore.js";
import { clearAllRecurringData } from "../recurring/recurringDetection.js";

/** "Delete everything / disconnect": revokes every connected Google
 * account's OAuth grant, clears every local cache, and leaves the app in a
 * fresh "not connected" state. Deliberately does NOT touch Notion (env vars
 * or content) — Notion is the user's own workspace, independent of Alfred —
 * and does NOT touch the Anthropic/OpenAI/ntfy config, since those are
 * Alfred's own operating credentials rather than connected-integration data. */
export async function wipeEverything(env: Env, googleAccounts: GoogleAccountEnv[]): Promise<void> {
  await Promise.all(googleAccounts.map((account) => revokeToken(account)));
  await removeAllAccounts(env);
  await clearAllEmails(env);
  await clearAllPushedNudges(env);
  await clearAllSnoozedNudges(env);
  await clearAllWeeklyDigests(env);
  await clearAllRecurringData(env);
}

import { updateEnvFile } from "../envFile";
import type { GoogleAccountEnv } from "../google/accounts";
import { removeAllAccounts } from "../google/accounts";
import { clearAllEmails } from "../google/gmailStore";
import { revokeToken } from "../google/oauth";
import { clearAllPushedNudges } from "../nudges/nudgeStore";

/** "Delete everything / disconnect": revokes every connected Google
 * account's OAuth grant, clears every local cache, and leaves the app in a
 * fresh "not connected" state. Deliberately does NOT touch Notion (env vars
 * or content) — Notion is the user's own workspace, independent of Alfred —
 * and does NOT touch the Anthropic/OpenAI/ntfy config, since those are
 * Alfred's own operating credentials rather than connected-integration data. */
export async function wipeEverything(googleAccounts: GoogleAccountEnv[]): Promise<void> {
  await Promise.all(googleAccounts.map((account) => revokeToken(account)));
  removeAllAccounts();
  // Legacy single-account var from before Step 8 — cleared too in case it's
  // still lingering from an older install that hasn't reconnected since.
  updateEnvFile(process.cwd() + "/.env", { GOOGLE_REFRESH_TOKEN: "" });
  clearAllEmails();
  clearAllPushedNudges();
}

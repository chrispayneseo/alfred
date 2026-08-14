import { updateEnvFile } from "../envFile";
import type { GoogleEnv } from "../google/env";
import { clearAllEmails } from "../google/gmailStore";
import { revokeToken } from "../google/oauth";
import { clearAllPushedNudges } from "../nudges/nudgeStore";

/** "Delete everything / disconnect": revokes Google's OAuth grant, clears
 * every local cache, and leaves the app in a fresh "not connected" state.
 * Deliberately does NOT touch Notion (env vars or content) — Notion is the
 * user's own workspace, independent of Alfred — and does NOT touch the
 * Anthropic/OpenAI/ntfy config, since those are Alfred's own operating
 * credentials rather than connected-integration data. */
export async function wipeEverything(googleEnv: GoogleEnv): Promise<void> {
  await revokeToken(googleEnv);
  updateEnvFile(process.cwd() + "/.env", { GOOGLE_REFRESH_TOKEN: "" });
  clearAllEmails();
  clearAllPushedNudges();
}

// Multi-account storage. These are credentials, not cached data, so they
// follow the same .env pattern as every other secret in this app (Notion
// token, LLM API keys, the original single Google refresh token) rather than
// living in SQLite alongside the Gmail/nudge caches — one JSON-array env var
// (GOOGLE_ACCOUNTS) holding [{email, refreshToken}, ...], in connection order.
import { oauth2_v2 } from "googleapis";
import { loadEnv } from "vite";
import { updateEnvFile } from "../envFile";
import { createOAuth2Client } from "./client";
import type { GoogleEnv } from "./env";

export interface GoogleAccountEnv extends GoogleEnv {
  email: string;
}

interface StoredAccount {
  email: string;
  refreshToken: string;
}

const ENV_PATH = process.cwd() + "/.env";

function parseStoredAccounts(raw: string | undefined): StoredAccount[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((a): a is StoredAccount => Boolean(a) && typeof a.email === "string" && typeof a.refreshToken === "string")
      : [];
  } catch {
    return [];
  }
}

function readStoredAccounts(): StoredAccount[] {
  const env = loadEnv("development", process.cwd(), "");
  return parseStoredAccounts(env.GOOGLE_ACCOUNTS);
}

function persistAccounts(accounts: StoredAccount[]): void {
  updateEnvFile(ENV_PATH, { GOOGLE_ACCOUNTS: JSON.stringify(accounts) });
}

/** All connected Google accounts, each carrying the shared app-level OAuth
 * client config (clientId/secret/redirectUri) plus its own refresh token and
 * email. Re-read per call (not cached) so a freshly-connected/disconnected
 * account is picked up immediately, same as loadGoogleEnv(). */
export function loadGoogleAccounts(base: GoogleEnv): GoogleAccountEnv[] {
  return readStoredAccounts().map((a) => ({ ...base, refreshToken: a.refreshToken, email: a.email }));
}

/** Fetches the Google account's real email address for a fresh refresh token
 * — used as the account's identity/label everywhere in the UI, rather than
 * asking the user to name it themselves. Requires the userinfo.email scope
 * (see oauth.ts) — the narrowest scope Google offers for this, grants no
 * Calendar/Gmail access of its own. */
async function fetchAccountEmail(base: GoogleEnv, refreshToken: string): Promise<string> {
  const client = createOAuth2Client(base);
  client.setCredentials({ refresh_token: refreshToken });
  const oauth2 = new oauth2_v2.Oauth2({ auth: client });
  const { data } = await oauth2.userinfo.get();
  if (!data.email) throw new Error("Google didn't return an account email.");
  return data.email;
}

/** Exchanges a fresh refresh token into a stored account — upserts by email
 * in place (preserving connection order, which the UI uses for stable color
 * assignment), so reconnecting an already-connected account refreshes its
 * token instead of creating a duplicate or reordering the list. Returns the
 * connected account's email. */
export async function connectAccount(base: GoogleEnv, refreshToken: string): Promise<string> {
  const email = await fetchAccountEmail(base, refreshToken);
  const stored = readStoredAccounts();
  const existingIndex = stored.findIndex((a) => a.email === email);
  if (existingIndex >= 0) stored[existingIndex] = { email, refreshToken };
  else stored.push({ email, refreshToken });
  persistAccounts(stored);
  return email;
}

/** Removes one account's stored token. Caller is responsible for revoking it
 * with Google first (see oauth.ts's revokeToken) and clearing its cached data. */
export function removeAccount(email: string): void {
  persistAccounts(readStoredAccounts().filter((a) => a.email !== email));
}

export function removeAllAccounts(): void {
  persistAccounts([]);
}

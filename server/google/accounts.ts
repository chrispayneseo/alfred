// Multi-account storage. These are credentials, so — unlike the Gmail/nudge
// caches — they used to follow the app's .env-secret pattern (one JSON-array
// env var, GOOGLE_ACCOUNTS). That doesn't survive Vercel: env vars are
// read-only at runtime there, so a newly-connected account could never be
// persisted. Accounts (and their live "needs reconnecting" health, which
// used to be a separate in-memory Map in accountStatus.ts) now live in the
// google_accounts Postgres table (server/db.ts) — one database for local dev
// and production, so this file behaves identically in both.
import { oauth2_v2 } from "googleapis";
import { ensureSchema, getSql, type Env } from "../db";
import { createOAuth2Client } from "./client";
import { loadGoogleEnv, type GoogleEnv } from "./env";

export interface GoogleAccountEnv extends GoogleEnv {
  email: string;
}

export type AccountHealth = "ok" | "reconnect_required";

export interface AccountSummary {
  email: string;
  health: AccountHealth;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

/** All connected Google accounts, each carrying the shared app-level OAuth
 * client config (clientId/secret/redirectUri) plus its own refresh token and
 * email, in connection order (the UI uses this order for stable color
 * assignment). Re-read per call (not cached) so a freshly-connected or
 * disconnected account is picked up immediately. */
export async function loadGoogleAccounts(env: Env): Promise<GoogleAccountEnv[]> {
  const sql = await db(env);
  const base = loadGoogleEnv(env);
  const rows = (await sql.query(
    "SELECT email, refresh_token FROM google_accounts ORDER BY connected_at ASC"
  )) as { email: string; refresh_token: string }[];
  return rows.map((r) => ({ ...base, refreshToken: r.refresh_token, email: r.email }));
}

/** Same accounts, with their live health — used by Settings to show
 * "needs reconnecting" without making a live Google call just to render. */
export async function listAccountsWithHealth(env: Env): Promise<AccountSummary[]> {
  const sql = await db(env);
  const rows = (await sql.query(
    "SELECT email, health FROM google_accounts ORDER BY connected_at ASC"
  )) as { email: string; health: AccountHealth }[];
  return rows.map((r) => ({ email: r.email, health: r.health }));
}

export async function markAccountOk(env: Env, email: string): Promise<void> {
  const sql = await db(env);
  await sql.query("UPDATE google_accounts SET health = 'ok' WHERE email = $1", [email]);
}

export async function markAccountNeedsReconnect(env: Env, email: string): Promise<void> {
  const sql = await db(env);
  await sql.query("UPDATE google_accounts SET health = 'reconnect_required' WHERE email = $1", [email]);
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
 * (reconnecting an already-connected account refreshes its token and resets
 * health to "ok" in place, rather than creating a duplicate). Returns the
 * connected account's email. */
export async function connectAccount(env: Env, base: GoogleEnv, refreshToken: string): Promise<string> {
  const email = await fetchAccountEmail(base, refreshToken);
  const sql = await db(env);
  await sql.query(
    `INSERT INTO google_accounts (email, refresh_token, health)
     VALUES ($1, $2, 'ok')
     ON CONFLICT (email) DO UPDATE SET refresh_token = excluded.refresh_token, health = 'ok'`,
    [email, refreshToken]
  );
  return email;
}

/** Removes one account's stored token. Caller is responsible for revoking it
 * with Google first (see oauth.ts's revokeToken) and clearing its cached data. */
export async function removeAccount(env: Env, email: string): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM google_accounts WHERE email = $1", [email]);
}

export async function removeAllAccounts(env: Env): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM google_accounts");
}

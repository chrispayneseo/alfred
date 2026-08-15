import crypto from "node:crypto";
import { createOAuth2Client } from "./client.js";
import type { GoogleEnv } from "./env.js";

// Was calendar.readonly through Step 8; upgraded to calendar.events (read +
// write events, but not calendar settings/ACLs — still the narrowest scope
// that covers both listing events and creating them) once Chat gained the
// ability to propose and create calendar events. Existing connections made
// before this change only hold the old readonly grant, so a write attempt
// against one fails with Google's insufficient-scope 403 — already handled
// as GoogleReconnectRequiredError by isGoogleAuthError (errors.ts), same as
// any other stale grant, so accounts self-heal via the normal reconnect
// flow rather than needing special-case handling.
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
// Read is separate from compose so the reconnect story stays honest about what
// each grants. gmail.compose is Google's narrowest scope that allows draft
// creation — its own scope description says "Manage drafts and send emails",
// meaning the OAuth grant itself technically permits sending. Alfred's code
// never calls the send endpoints (see server/google/gmail.ts) — that's where
// the "never sends automatically" guarantee actually lives, not in the scope.
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
// Step 8 (multi-account): the narrowest scope Google offers for reading the
// connected account's own email address — grants no Calendar/Gmail access of
// its own. Needed to label each connected account by its real address rather
// than asking the user to name it (server/google/accounts.ts).
export const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
// Read-only Search Console access — property discovery + search analytics,
// nothing that can add/remove a site or change settings. Accounts connected
// before this scope existed only hold the old grant; a Search Console call
// against one fails with Google's insufficient-scope 403, already handled as
// GoogleReconnectRequiredError by isGoogleAuthError (errors.ts), same
// self-healing-via-reconnect story as CALENDAR_EVENTS_SCOPE's upgrade above.
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

const SCOPES = [CALENDAR_EVENTS_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE, USERINFO_EMAIL_SCOPE, SEARCH_CONSOLE_SCOPE];

// Stateless CSRF protection for the OAuth flow: a timestamp + random nonce,
// HMAC-signed with the app's own GOOGLE_CLIENT_SECRET (already a private
// secret with no other cryptographic use here, so no new secret is needed).
// A module-level "pending state" variable — what this replaces — doesn't
// survive Vercel's stateless, potentially multi-instance serverless model,
// where the callback request can land on a different instance than the one
// that generated the auth URL.
//
// Trade-off, accepted deliberately: the old in-memory token was single-use
// (cleared on first check), which also blocked replay. This signed token is
// valid for its whole freshness window below, so a captured still-fresh
// state could in principle be replayed within that window. Acceptable for a
// single-user personal app — not equivalent security to the mechanism it
// replaces, and worth remembering if this pattern is ever reused somewhere
// with a real multi-user threat model.
const STATE_FRESHNESS_MS = 10 * 60 * 1000;

function signState(clientSecret: string, timestamp: number, nonce: string): string {
  return crypto.createHmac("sha256", clientSecret).update(`${timestamp}.${nonce}`).digest("hex");
}

function generateState(clientSecret: string): string {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");
  return `${timestamp}.${nonce}.${signState(clientSecret, timestamp, nonce)}`;
}

export function isValidState(state: string | null, clientSecret: string): boolean {
  if (!state) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [timestampStr, nonce, signature] = parts;

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > STATE_FRESHNESS_MS) return false;

  const expected = Buffer.from(signState(clientSecret, timestamp, nonce), "hex");
  const actual = Buffer.from(signature, "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function getAuthUrl(env: GoogleEnv, options?: { loginHint?: string }): string {
  const client = createOAuth2Client(env);
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // guarantees a refresh_token even on a reconnect, and re-prompts for newly added scopes
    state: generateState(env.clientSecret),
    // Pre-selects/suggests the right account in Google's picker when
    // reconnecting a specific already-connected account, so it's harder to
    // accidentally re-auth the wrong one. Left out of the options object
    // entirely (not just undefined) when connecting a new account, since
    // google-auth-library's querystring.stringify would otherwise emit a
    // meaningless empty `login_hint=` param.
    ...(options?.loginHint ? { login_hint: options.loginHint } : {}),
  });
}

/** Exchanges an OAuth code for tokens and returns the refresh token to persist. */
export async function exchangeCodeForRefreshToken(env: GoogleEnv, code: string): Promise<string> {
  const client = createOAuth2Client(env);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google didn't return a refresh token. Try reconnecting — if you've connected before, revoke Alfred's access at myaccount.google.com/permissions first."
    );
  }
  return tokens.refresh_token;
}

/** Revokes the stored refresh token with Google directly (not just deleting
 * it locally) — used by the settings "delete everything / disconnect" flow.
 * Best-effort: an already-invalid token still counts as successfully
 * disconnected from Alfred's point of view. */
export async function revokeToken(env: GoogleEnv): Promise<void> {
  if (!env.refreshToken) return;
  const client = createOAuth2Client(env);
  try {
    await client.revokeToken(env.refreshToken);
  } catch (error) {
    console.error("[oauth] token revocation failed (continuing — token will still be cleared locally):", error);
  }
}

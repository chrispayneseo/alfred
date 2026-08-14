import crypto from "node:crypto";
import { createOAuth2Client } from "./client";
import type { GoogleEnv } from "./env";

export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
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

const SCOPES = [CALENDAR_READONLY_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE, USERINFO_EMAIL_SCOPE];

// Single-user local dev flow — an in-memory pending state is enough to guard
// against CSRF on the callback without needing a session store.
let pendingState: string | undefined;

export function getAuthUrl(env: GoogleEnv, options?: { loginHint?: string }): string {
  const client = createOAuth2Client(env);
  pendingState = crypto.randomBytes(16).toString("hex");
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // guarantees a refresh_token even on a reconnect, and re-prompts for newly added scopes
    state: pendingState,
    // Pre-selects/suggests the right account in Google's picker when
    // reconnecting a specific already-connected account, so it's harder to
    // accidentally re-auth the wrong one. Left out of the options object
    // entirely (not just undefined) when connecting a new account, since
    // google-auth-library's querystring.stringify would otherwise emit a
    // meaningless empty `login_hint=` param.
    ...(options?.loginHint ? { login_hint: options.loginHint } : {}),
  });
}

export function isValidState(state: string | null): boolean {
  const valid = !!state && state === pendingState;
  pendingState = undefined;
  return valid;
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

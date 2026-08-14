import crypto from "node:crypto";
import { createOAuth2Client } from "./client";
import type { GoogleEnv } from "./env";

export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

// Single-user local dev flow — an in-memory pending state is enough to guard
// against CSRF on the callback without needing a session store.
let pendingState: string | undefined;

export function getAuthUrl(env: GoogleEnv): string {
  const client = createOAuth2Client(env);
  pendingState = crypto.randomBytes(16).toString("hex");
  return client.generateAuthUrl({
    access_type: "offline",
    scope: [CALENDAR_READONLY_SCOPE],
    prompt: "consent", // guarantees a refresh_token even on a reconnect
    state: pendingState,
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

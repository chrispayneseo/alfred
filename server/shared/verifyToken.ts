import { timingSafeEqual } from "node:crypto";

/** Constant-time shared-secret check for public, token-gated webhooks (e.g.
 * locationTrigger/webhook.ts, cron/env.ts's Gmail refresh endpoint) — an
 * early-exit string compare leaks how many leading characters of a guess
 * were correct via response timing, the same reasoning as oauth.ts's signed
 * state. Fails closed (false) if the expected value isn't configured at
 * all, rather than treating "no secret set" as "no secret required." */
export function isValidToken(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

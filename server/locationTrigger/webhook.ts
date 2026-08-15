import { timingSafeEqual } from "node:crypto";
import type { NotionRepo } from "../notion/queries.js";
import type { NtfyEnv } from "../notify/env.js";
import { notify } from "../notify/ntfy.js";

/** Takes a raw env source rather than loading one itself — see
 * google/env.ts for why (dev uses Vite's loadEnv(), prod uses process.env). */
export function loadLocationTriggerSecret(source: Record<string, string | undefined>): string {
  return source.LOCATION_TRIGGER_SECRET ?? "";
}

/** This is a public, unauthenticated-beyond-the-token webhook — anyone who
 * finds the URL and guesses right gets to fire reminders. A constant-time
 * comparison matters here for the same reason as oauth.ts's signed state:
 * an early-exit string compare leaks how many leading characters of a
 * guess were correct via response timing. Fails closed (false) if the
 * secret isn't configured at all, rather than treating "no secret set" as
 * "no secret required." */
export function isValidLocationTriggerToken(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normalize(location: string): string {
  return location.trim().toLowerCase();
}

export interface LocationTriggerResult {
  matched: number;
}

/** Looks up every open, not-yet-fired location reminder, matches the ones
 * whose place name equals (case-insensitively) the location Tasker just
 * sent, and — only if there's at least one — pushes a single bundled
 * notification (not one push per matching Task) and marks each as fired
 * so it's a one-shot: it won't repeat on the next geofence event for the
 * same place. A geofence firing with nothing waiting for it is a normal,
 * silent outcome, not an error — the caller (the /api/location-trigger
 * route) always returns 200 either way. */
export async function processLocationTrigger(repo: NotionRepo, ntfyEnv: NtfyEnv, location: string): Promise<LocationTriggerResult> {
  const reminders = await repo.listOpenLocationReminders();
  const target = normalize(location);
  const matches = reminders.filter((r) => normalize(r.locationTrigger) === target);
  if (matches.length === 0) return { matched: 0 };

  const title = matches.length === 1 ? `Reminder - ${location}` : `${matches.length} reminders - ${location}`;
  const body = matches.map((m) => `• ${m.title}`).join("\n");
  await notify(ntfyEnv.topic, body, title);

  await Promise.all(matches.map((m) => repo.markLocationReminderTriggered(m.id)));
  return { matched: matches.length };
}

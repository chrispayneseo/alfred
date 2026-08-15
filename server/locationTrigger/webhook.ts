import type { NotionRepo } from "../notion/queries.js";
import type { NtfyEnv } from "../notify/env.js";
import { notify } from "../notify/ntfy.js";

/** Takes a raw env source rather than loading one itself — see
 * google/env.ts for why (dev uses Vite's loadEnv(), prod uses process.env). */
export function loadLocationTriggerSecret(source: Record<string, string | undefined>): string {
  return source.LOCATION_TRIGGER_SECRET ?? "";
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

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly";

export interface PendingSuggestion {
  id: string;
  title: string;
  cadence: Cadence;
  reason: string;
}

async function postJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

/** Check-on-open: rolls over any accepted recurring task that's due, scans
 * for new suggestions at most once a week, returns current pending list. */
export async function checkRecurring(): Promise<PendingSuggestion[]> {
  const res = await fetch("/api/recurring/check");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function fetchPendingSuggestions(): Promise<PendingSuggestion[]> {
  const res = await fetch("/api/recurring/suggestions");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export function scanForRecurringPatterns(): Promise<{ created: number }> {
  return postJson("/api/recurring/scan");
}

export function acceptSuggestion(id: string): Promise<void> {
  return postJson(`/api/recurring/suggestions/${encodeURIComponent(id)}/accept`);
}

export function dismissSuggestion(id: string): Promise<void> {
  return postJson(`/api/recurring/suggestions/${encodeURIComponent(id)}/dismiss`);
}

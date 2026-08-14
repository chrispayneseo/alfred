export interface GroupingItem {
  id: string;
  kind: "task" | "note";
  title: string;
}

export interface PendingGrouping {
  id: string;
  suggestedName: string;
  reason: string;
  items: GroupingItem[];
}

async function postJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

/** Check-on-open: scans for new suggestions at most once a week, returns
 * current pending list. */
export async function checkProjectGroupings(): Promise<PendingGrouping[]> {
  const res = await fetch("/api/project-groupings/check");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function fetchPendingGroupings(): Promise<PendingGrouping[]> {
  const res = await fetch("/api/project-groupings/suggestions");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export function scanForProjectGroupings(): Promise<{ created: number }> {
  return postJson("/api/project-groupings/scan");
}

export function acceptGrouping(id: string): Promise<void> {
  return postJson(`/api/project-groupings/suggestions/${encodeURIComponent(id)}/accept`);
}

export function dismissGrouping(id: string): Promise<void> {
  return postJson(`/api/project-groupings/suggestions/${encodeURIComponent(id)}/dismiss`);
}

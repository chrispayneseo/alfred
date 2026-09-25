const BASE = "https://alfred.tailde2d45.ts.net";
const ROOT = `${BASE}/v1/core/proactive`;

export type ProactiveBand = "urgent" | "important" | "later";

export interface ProactiveItem {
  id: string;
  source: string;
  kind: string;
  priority: number;
  band: ProactiveBand;
  title: string;
  summary: string;
}

export interface ProactiveCounts {
  total: number;
  urgent: number;
  important: number;
  later: number;
}

export interface ProactiveBrief {
  generated_at: string;
  headline: string;
  quiet_hours: boolean;
  counts: ProactiveCounts;
  items: ProactiveItem[];
  delivery: "disabled";
  synthesis: "deterministic_local";
}

export interface MorningBrief {
  id: string;
  brief_date: string;
  generated_at: string;
  headline: string;
  counts: ProactiveCounts;
  items: ProactiveItem[];
  source_run_id: string | null;
  synthesis: "deterministic_local";
  delivery: "disabled";
}

export interface MorningBriefStatus {
  enabled: boolean;
  scheduled_time: string;
  local_date: string;
  due: boolean;
  reason: "disabled" | "already_generated" | "before_schedule" | "due" | string;
  today_generated: boolean;
  latest_brief_date: string | null;
  delivery: "disabled";
}

export type InterruptionDecision =
  | { decision: "hold_quiet_hours"; item: null; delivery: "disabled" }
  | { decision: "nothing_to_surface"; item: null; delivery: "disabled" }
  | { decision: "hold_cooldown"; item: null; cooldown_remaining_minutes: number; delivery: "disabled" }
  | { decision: "surface_candidate"; item: Omit<ProactiveItem, "band">; delivery: "disabled" };

async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${ROOT}${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Can't reach Alfred's Dell. Check that Tailscale is connected, then try again.");
  }
  return response;
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  if (!response.ok) throw new Error(`Could not load Alfred's proactive brief (${response.status})`);
  return await response.json() as T;
}

export async function fetchProactiveBrief(limit = 8): Promise<ProactiveBrief> {
  return jsonRequest<ProactiveBrief>(`/brief?limit=${encodeURIComponent(String(limit))}`);
}

export async function fetchMorningBriefStatus(): Promise<MorningBriefStatus> {
  return jsonRequest<MorningBriefStatus>("/morning-brief/status");
}

export async function fetchLatestMorningBrief(): Promise<MorningBrief | null> {
  const response = await request("/morning-brief/latest");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not load Alfred's morning brief (${response.status})`);
  return await response.json() as MorningBrief;
}

export async function fetchInterruptionDecision(): Promise<InterruptionDecision> {
  return jsonRequest<InterruptionDecision>("/interruption");
}

export async function markProactiveSurfaced(itemId: string): Promise<void> {
  const response = await request(`/items/${encodeURIComponent(itemId)}/surface`, { method: "POST" });
  if (!response.ok) throw new Error(`Could not record Alfred's surfaced item (${response.status})`);
}

export async function dismissProactiveItem(itemId: string): Promise<void> {
  const response = await request(`/items/${encodeURIComponent(itemId)}/dismiss`, { method: "POST" });
  if (!response.ok) throw new Error(`Could not dismiss Alfred's item (${response.status})`);
}

export async function snoozeProactiveItem(itemId: string, minutes: number): Promise<void> {
  const response = await request(`/items/${encodeURIComponent(itemId)}/snooze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutes }),
  });
  if (!response.ok) throw new Error(`Could not snooze Alfred's item (${response.status})`);
}

export type MembershipTier = "base" | "plus" | "priority";

export interface TicketWindow {
  id: string;
  opponent: string;
  homeAway: "H" | "A";
  phaseLabel: string;
  phaseKind: "direct_sale" | "ballot_application";
  opensAt: string;
  closesAt?: string;
}

export interface ReviewWindow {
  id: string;
  opponent: string;
  homeAway: "H" | "A";
  phaseLabel: string;
  note: string;
  gmailRowKey: string;
}

export interface LeedsTicketsState {
  windows: TicketWindow[];
  review: ReviewWindow[];
  tier: MembershipTier;
}

export interface LeedsTicketSettings {
  tier: MembershipTier;
  earlyNudgeHours: number;
  closeNudgeHours: number;
}

export async function checkLeedsTickets(): Promise<LeedsTicketsState> {
  const res = await fetch("/api/leeds-tickets");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function actionTicketWindow(id: string): Promise<void> {
  const res = await fetch(`/api/leeds-tickets/${encodeURIComponent(id)}/action`, { method: "POST" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

export async function dismissReviewWindow(id: string): Promise<void> {
  const res = await fetch(`/api/leeds-tickets/${encodeURIComponent(id)}/dismiss-review`, { method: "POST" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

export async function fetchLeedsTicketSettings(): Promise<LeedsTicketSettings> {
  const res = await fetch("/api/leeds-tickets/settings");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function setLeedsTicketSettings(settings: LeedsTicketSettings): Promise<void> {
  const res = await fetch("/api/leeds-tickets/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

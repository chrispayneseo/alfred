export interface EvieProposal {
  id: string;
  accountEmail: string;
  threadId: string;
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  location?: string;
}

export interface EvieActionItem {
  id: string;
  accountEmail: string;
  threadId: string;
  subject: string;
  summary: string;
  reason: string;
  dueDate?: string;
}

async function postJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return res.json();
}

export async function fetchEvieProposals(): Promise<EvieProposal[]> {
  const res = await fetch("/api/evie/proposals");
  if (!res.ok) return [];
  return res.json();
}

export function acceptEvieProposal(id: string): Promise<{ ok: true }> {
  return postJson(`/api/evie/proposals/${id}/accept`);
}

export function dismissEvieProposal(id: string): Promise<{ ok: true }> {
  return postJson(`/api/evie/proposals/${id}/dismiss`);
}

export async function fetchEvieActionItems(): Promise<EvieActionItem[]> {
  const res = await fetch("/api/evie/action-items");
  if (!res.ok) return [];
  return res.json();
}

export function resolveEvieActionItem(id: string): Promise<{ ok: true }> {
  return postJson(`/api/evie/action-items/${id}/done`);
}

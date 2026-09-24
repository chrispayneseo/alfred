const BASE = "https://alfred.tailde2d45.ts.net";

export interface LocalMemory {
  id: number;
  created_at: string;
  kind: string;
  content: string;
  source: string;
}

export async function listLocalMemories(query = ""): Promise<LocalMemory[]> {
  const res = await fetch(`${BASE}/v1/memories?q=${encodeURIComponent(query)}&limit=50`);
  if (!res.ok) throw new Error(`Could not load local memory (${res.status})`);
  const body = await res.json() as { items: LocalMemory[] };
  return body.items;
}

export async function addLocalMemory(content: string, kind = "note"): Promise<void> {
  const res = await fetch(`${BASE}/v1/memories`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, kind, source: "alfred-web" }),
  });
  if (!res.ok) throw new Error(`Could not save memory (${res.status})`);
}

export async function deleteLocalMemory(id: number): Promise<void> {
  const res = await fetch(`${BASE}/v1/memories/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Could not delete memory (${res.status})`);
}

export type InboxKind = "note" | "task" | "reminder" | "clarify";

export interface WhatsAppInboxItem {
  id: string;
  body: string;
  sent_at: string;
  received_at: string;
  state: "new" | "review" | "filed";
  suggested_kind: InboxKind | null;
  suggested_title: string | null;
  suggested_due: string | null;
  suggested_detail: string | null;
  triaged_at: string | null;
  reviewed_at: string | null;
}

export interface FiledInboxItem {
  source_id: string;
  kind: Exclude<InboxKind, "clarify">;
  title: string;
  due: string | null;
  detail: string | null;
  created_at: string;
}

async function inboxRequest(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/v1/inbox${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Can't reach Alfred's Dell. Check that Tailscale is connected, then try Refresh.");
  }
  if (!response.ok) throw new Error(`Could not reach Alfred's local inbox (${response.status})`);
  return response;
}

export async function listWhatsAppInbox(): Promise<WhatsAppInboxItem[]> {
  const response = await inboxRequest("");
  return ((await response.json()) as { items: WhatsAppInboxItem[] }).items;
}

export async function listFiledWhatsApp(): Promise<FiledInboxItem[]> {
  const response = await inboxRequest("/filed");
  return ((await response.json()) as { items: FiledInboxItem[] }).items;
}

export async function triageWhatsApp(id: string): Promise<void> {
  await inboxRequest(`/${encodeURIComponent(id)}/triage`, { method: "POST" });
}

export async function fileWhatsApp(id: string, filing: {
  kind: Exclude<InboxKind, "clarify">;
  title: string;
  due: string | null;
  detail: string;
}): Promise<void> {
  await inboxRequest(`/${encodeURIComponent(id)}/file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filing),
  });
}

export async function discardWhatsApp(id: string): Promise<void> {
  await inboxRequest(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}

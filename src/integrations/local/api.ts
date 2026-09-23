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

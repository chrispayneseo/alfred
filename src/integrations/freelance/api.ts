export interface ClientSummary {
  name: string;
  openTaskCount: number;
  noteCount: number;
}

export interface ClientTask {
  id: string;
  title: string;
  done: boolean;
  due?: string;
  client?: string;
}

export interface ClientNote {
  id: string;
  title: string;
  updatedAt: string;
  client?: string;
}

export interface ClientEmail {
  id: string;
  accountEmail: string;
  threadId: string;
  sender: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface ClientView {
  client: string;
  tasks: ClientTask[];
  notes: ClientNote[];
  emails: ClientEmail[];
}

export async function fetchFreelanceClients(): Promise<ClientSummary[]> {
  const res = await fetch("/api/freelance/clients");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function fetchClientView(client: string): Promise<ClientView> {
  const res = await fetch(`/api/freelance/clients/${encodeURIComponent(client)}`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export interface GmailStatus {
  connected: boolean;
  lastSyncAt?: string;
  totalEmails: number;
  unscannedCount: number;
  flaggedCount: number;
}

export interface SyncStatus {
  running: boolean;
  processed: number;
  total?: number;
  error?: string;
  lastSyncAt?: string;
}

export interface ScanStatus {
  running: boolean;
  processed: number;
  total: number;
  error?: string;
}

export interface FlaggedEmail {
  id: string;
  accountEmail: string;
  threadId: string;
  sender: string;
  senderEmail: string;
  subject: string;
  date: string;
  snippet: string;
  needsReply: boolean;
  hasDeadline: boolean;
  deadlineDate?: string;
  project?: string;
  itemType?: "task" | "note";
  notionPageId?: string;
  draftId?: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(typeof errBody.error === "string" ? errBody.error : `Request failed (${res.status})`);
  }
  return res.json();
}

export async function fetchGmailStatus(): Promise<GmailStatus> {
  const res = await fetch("/api/gmail/status");
  if (!res.ok) return { connected: false, totalEmails: 0, unscannedCount: 0, flaggedCount: 0 };
  return res.json();
}

export function startGmailSync(days: number): Promise<SyncStatus> {
  return postJson("/api/gmail/sync/start", { days });
}

export async function fetchGmailSyncStatus(): Promise<SyncStatus> {
  const res = await fetch("/api/gmail/sync/status");
  return res.json();
}

export function startGmailScan(limit: number): Promise<ScanStatus> {
  return postJson("/api/gmail/scan/start", { limit });
}

export async function fetchGmailScanStatus(): Promise<ScanStatus> {
  const res = await fetch("/api/gmail/scan/status");
  return res.json();
}

export async function fetchFlaggedEmails(): Promise<FlaggedEmail[]> {
  const res = await fetch("/api/gmail/flagged");
  if (!res.ok) return [];
  return res.json();
}

export function dismissFlaggedEmail(accountEmail: string, id: string): Promise<void> {
  return postJson("/api/gmail/flagged/dismiss", { accountEmail, id });
}

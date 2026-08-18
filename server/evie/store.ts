// Postgres access for Evie (the school-email monitor) — mirrors the shape of
// nudgeStore.ts / recurringDetection.ts. Candidates are drawn from the
// existing gmail_emails sync cache (server/google/gmailStore.ts), never a
// live Gmail search — see check.ts for why. Deliberately narrow to the
// school's own sender domain (an explicit requirement, not a general inbox
// scan) — but NOT also AND'd with a keyword match here, unlike the
// standalone version's live Gmail query: the cache only stores a short
// snippet, not the full body, so a real school email whose relevant keyword
// (e.g. "Year 3") is buried mid-newsletter would never match a snippet-only
// keyword filter and would be silently dropped. The sender-domain match
// alone is already narrow; EVIE_KEYWORD_TERMS still does its precision work
// in the LLM classification prompt (evieScan.ts), which sees the full body.
import { ensureSchema, getSql, type Env } from "../db.js";
import { EVIE_SENDER_FILTER } from "./filters.js";

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

export interface EvieCandidate {
  rowKey: string;
  accountEmail: string;
  id: string;
  threadId: string;
  sender: string;
  senderEmail: string;
  subject: string;
  date: string;
  snippet: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCandidate(row: any): EvieCandidate {
  return {
    rowKey: row.row_key,
    accountEmail: row.account_email,
    id: row.id,
    threadId: row.thread_id,
    sender: row.sender,
    senderEmail: row.sender_email,
    subject: row.subject,
    date: new Date(row.date).toISOString(),
    snippet: row.snippet,
  };
}

/** Unscanned gmail_emails rows for the given account whose sender matches
 * EVIE_SENDER_FILTER — narrow to the school's own domain, not a general
 * inbox scan. See the file header for why this doesn't also filter on
 * EVIE_KEYWORD_TERMS here (that happens downstream, against the full body). */
export async function getEvieCandidates(env: Env, accountEmail: string, limit: number): Promise<EvieCandidate[]> {
  const sql = await db(env);
  const rows = await sql.query(
    `SELECT g.* FROM gmail_emails g
     LEFT JOIN evie_scanned_messages s ON s.row_key = g.row_key
     WHERE g.account_email = $1 AND g.sender_email ILIKE $2 AND s.row_key IS NULL
     ORDER BY g.date DESC
     LIMIT $3`,
    [accountEmail, `%${EVIE_SENDER_FILTER}%`, limit]
  );
  return rows.map(toCandidate);
}

export async function markEvieScanned(env: Env, rowKey: string): Promise<void> {
  const sql = await db(env);
  await sql.query("INSERT INTO evie_scanned_messages (row_key) VALUES ($1) ON CONFLICT (row_key) DO NOTHING", [rowKey]);
}

export interface EvieEventProposal {
  id: string;
  accountEmail: string;
  threadId: string;
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  location?: string;
}

export async function insertEventProposal(
  env: Env,
  input: {
    gmailRowKey: string;
    accountEmail: string;
    threadId: string;
    title: string;
    date: string;
    startTime?: string;
    endTime?: string;
    location?: string;
  }
): Promise<void> {
  const sql = await db(env);
  await sql.query(
    `INSERT INTO evie_event_proposals (id, gmail_row_key, account_email, thread_id, title, date, start_time, end_time, location, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
    [
      crypto.randomUUID(),
      input.gmailRowKey,
      input.accountEmail,
      input.threadId,
      input.title,
      input.date,
      input.startTime ?? null,
      input.endTime ?? null,
      input.location ?? null,
    ]
  );
}

export async function listPendingEventProposals(env: Env): Promise<EvieEventProposal[]> {
  const sql = await db(env);
  const rows = (await sql.query(
    `SELECT id, account_email, thread_id, title, date, start_time, end_time, location
     FROM evie_event_proposals WHERE status = 'pending' ORDER BY date ASC`
  )) as {
    id: string;
    account_email: string;
    thread_id: string;
    title: string;
    date: string;
    start_time: string | null;
    end_time: string | null;
    location: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    accountEmail: r.account_email,
    threadId: r.thread_id,
    title: r.title,
    date: r.date,
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
    location: r.location ?? undefined,
  }));
}

export async function markProposalAccepted(env: Env, id: string): Promise<void> {
  const sql = await db(env);
  await sql.query("UPDATE evie_event_proposals SET status = 'accepted' WHERE id = $1", [id]);
}

export async function markProposalDismissed(env: Env, id: string): Promise<void> {
  const sql = await db(env);
  await sql.query("UPDATE evie_event_proposals SET status = 'dismissed' WHERE id = $1", [id]);
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

export async function insertActionItem(
  env: Env,
  input: { gmailRowKey: string; accountEmail: string; threadId: string; subject: string; summary: string; reason: string; dueDate?: string }
): Promise<void> {
  const sql = await db(env);
  await sql.query(
    `INSERT INTO evie_action_items (id, gmail_row_key, account_email, thread_id, subject, summary, reason, due_date, resolved)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
    [crypto.randomUUID(), input.gmailRowKey, input.accountEmail, input.threadId, input.subject, input.summary, input.reason, input.dueDate ?? null]
  );
}

export async function listOpenActionItems(env: Env): Promise<EvieActionItem[]> {
  const sql = await db(env);
  const rows = (await sql.query(
    `SELECT id, account_email, thread_id, subject, summary, reason, due_date
     FROM evie_action_items WHERE resolved = false ORDER BY created_at DESC`
  )) as { id: string; account_email: string; thread_id: string; subject: string; summary: string; reason: string; due_date: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    accountEmail: r.account_email,
    threadId: r.thread_id,
    subject: r.subject,
    summary: r.summary,
    reason: r.reason,
    dueDate: r.due_date ?? undefined,
  }));
}

export async function resolveActionItem(env: Env, id: string): Promise<void> {
  const sql = await db(env);
  await sql.query("UPDATE evie_action_items SET resolved = true WHERE id = $1", [id]);
}

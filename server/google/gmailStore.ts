// Metadata cache for Gmail — sender/subject/date/snippet/threadId only,
// never raw bodies (those are fetched on demand, see gmail.ts). Postgres
// (server/db.ts), same database as the accounts table and nudge store.
import { ensureSchema, getSql, type Env } from "../db.js";

export interface EmailRecord {
  id: string;
  accountEmail: string;
  threadId: string;
  sender: string;
  senderEmail: string;
  subject: string;
  date: string; // ISO
  snippet: string;
  scanned: boolean;
  actionable: boolean;
  needsReply: boolean;
  hasDeadline: boolean;
  deadlineDate?: string;
  project?: string;
  itemType?: "task" | "note";
  notionPageId?: string;
  draftId?: string;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

function rowKey(accountEmail: string, id: string): string {
  return `${accountEmail}:${id}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecord(row: any): EmailRecord {
  return {
    id: row.id,
    accountEmail: row.account_email,
    threadId: row.thread_id,
    sender: row.sender,
    senderEmail: row.sender_email,
    subject: row.subject,
    date: new Date(row.date).toISOString(),
    snippet: row.snippet,
    scanned: row.scanned,
    actionable: row.actionable,
    needsReply: row.needs_reply,
    hasDeadline: row.has_deadline,
    deadlineDate: row.deadline_date ?? undefined,
    project: row.project ?? undefined,
    itemType: row.item_type ?? undefined,
    notionPageId: row.notion_page_id ?? undefined,
    draftId: row.draft_id ?? undefined,
  };
}

export interface EmailMetadataInput {
  id: string;
  accountEmail: string;
  threadId: string;
  sender: string;
  senderEmail: string;
  subject: string;
  date: string;
  snippet: string;
}

/** Inserts new email metadata; a message already stored (by account + id) is
 * left untouched (its scan state shouldn't be reset by re-running sync over
 * overlapping ranges). */
export async function upsertEmailMetadata(env: Env, records: EmailMetadataInput[]): Promise<void> {
  if (records.length === 0) return;
  const sql = await db(env);
  for (const r of records) {
    await sql.query(
      `INSERT INTO gmail_emails (row_key, account_email, id, thread_id, sender, sender_email, subject, date, snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (row_key) DO NOTHING`,
      [rowKey(r.accountEmail, r.id), r.accountEmail, r.id, r.threadId, r.sender, r.senderEmail, r.subject, r.date, r.snippet]
    );
  }
}

export async function getUnscannedEmails(env: Env, limit: number): Promise<EmailRecord[]> {
  const sql = await db(env);
  const rows = await sql.query("SELECT * FROM gmail_emails WHERE scanned = false ORDER BY date DESC LIMIT $1", [limit]);
  return rows.map(toRecord);
}

export async function countUnscanned(env: Env): Promise<number> {
  const sql = await db(env);
  const [row] = (await sql.query("SELECT COUNT(*) as n FROM gmail_emails WHERE scanned = false")) as { n: string }[];
  return Number(row.n);
}

export async function countTotal(env: Env): Promise<number> {
  const sql = await db(env);
  const [row] = (await sql.query("SELECT COUNT(*) as n FROM gmail_emails")) as { n: string }[];
  return Number(row.n);
}

export async function countFlagged(env: Env): Promise<number> {
  const sql = await db(env);
  const [row] = (await sql.query("SELECT COUNT(*) as n FROM gmail_emails WHERE actionable = true")) as { n: string }[];
  return Number(row.n);
}

export async function getFlaggedEmails(env: Env, limit = 50): Promise<EmailRecord[]> {
  const sql = await db(env);
  const rows = await sql.query("SELECT * FROM gmail_emails WHERE actionable = true ORDER BY date DESC LIMIT $1", [limit]);
  return rows.map(toRecord);
}

/** Searches the full synced-email cache (not just flagged/actionable ones)
 * for any of the given terms appearing in the sender address, sender name,
 * or subject — used by the Freelance client view to surface relevant email
 * by client name/known contact domain, reusing Step 5's sync/cache rather
 * than hitting Gmail live. */
export async function searchEmailsByTerms(env: Env, terms: string[], limit = 10): Promise<EmailRecord[]> {
  if (terms.length === 0) return [];
  const sql = await db(env);

  const conditions: string[] = [];
  const params: string[] = [];
  for (const term of terms) {
    const p = `%${term}%`;
    conditions.push(`(sender_email ILIKE $${params.length + 1} OR sender ILIKE $${params.length + 2} OR subject ILIKE $${params.length + 3})`);
    params.push(p, p, p);
  }

  const rows = await sql.query(
    `SELECT * FROM gmail_emails WHERE ${conditions.join(" OR ")} ORDER BY date DESC LIMIT $${params.length + 1}`,
    [...params, limit]
  );
  return rows.map(toRecord);
}

/** Removes an email from the Flagged list without touching the actual
 * Gmail message, any draft already created for it, or any Notion page it
 * was filed to — those are separately manageable (Gmail directly, Browse's
 * task/note remove). Just tells Alfred to stop surfacing this one. */
export async function dismissFlaggedEmail(env: Env, accountEmail: string, id: string): Promise<void> {
  const sql = await db(env);
  await sql.query("UPDATE gmail_emails SET actionable = false WHERE row_key = $1", [rowKey(accountEmail, id)]);
}

export interface ScanResult {
  actionable: boolean;
  needsReply: boolean;
  hasDeadline: boolean;
  deadlineDate?: string;
  project?: string;
  itemType?: "task" | "note";
  notionPageId?: string;
  draftId?: string;
}

export async function markScanned(env: Env, accountEmail: string, id: string, result: ScanResult): Promise<void> {
  const sql = await db(env);
  await sql.query(
    `UPDATE gmail_emails
     SET scanned = true, actionable = $1, needs_reply = $2, has_deadline = $3, deadline_date = $4,
         project = $5, item_type = $6, notion_page_id = $7, draft_id = $8
     WHERE row_key = $9`,
    [
      result.actionable,
      result.needsReply,
      result.hasDeadline,
      result.deadlineDate ?? null,
      result.project ?? null,
      result.itemType ?? null,
      result.notionPageId ?? null,
      result.draftId ?? null,
      rowKey(accountEmail, id),
    ]
  );
}

/** All cached email metadata, for the data export — same fields as everywhere
 * else in this store (metadata only, never raw bodies). */
export async function getAllEmails(env: Env): Promise<EmailRecord[]> {
  const sql = await db(env);
  const rows = await sql.query("SELECT * FROM gmail_emails ORDER BY date DESC");
  return rows.map(toRecord);
}

/** Wipes the entire cached Gmail metadata — used by the settings "delete
 * everything / disconnect" flow. Does not touch Gmail or Notion themselves. */
export async function clearAllEmails(env: Env): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM gmail_emails");
  await sql.query("DELETE FROM gmail_meta");
}

/** Clears just one account's cached emails — used when disconnecting a
 * single account (Step 8) rather than the full wipe. */
export async function clearEmailsForAccount(env: Env, accountEmail: string): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM gmail_emails WHERE account_email = $1", [accountEmail]);
}

export async function getMeta(env: Env, key: string): Promise<string | undefined> {
  const sql = await db(env);
  const rows = (await sql.query("SELECT value FROM gmail_meta WHERE key = $1", [key])) as { value: string }[];
  return rows[0]?.value;
}

export async function setMeta(env: Env, key: string, value: string): Promise<void> {
  const sql = await db(env);
  await sql.query(
    "INSERT INTO gmail_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

// Local metadata cache for Gmail — sender/subject/date/snippet/threadId only,
// never raw bodies (those are fetched on demand, see gmail.ts). SQLite via
// Node's built-in node:sqlite, so no new dependency; this is a stand-in for
// wherever this data lives once Supabase is in place.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

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

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "gmail.db");

let db: DatabaseSync | undefined;

function rowKey(accountEmail: string, id: string): string {
  return `${accountEmail}:${id}`;
}

function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);

  // Step 5's schema keyed emails by Gmail message id alone, which is only
  // guaranteed unique within one account's mailbox. Step 8 (multi-account)
  // needs (accountEmail, id) instead. This is a cache, not source of truth
  // (see Step 5/7), so upgrading in place just rebuilds the table — a re-sync
  // repopulates it — rather than writing a real column migration.
  const columns = db.prepare(`PRAGMA table_info(emails)`).all() as { name: string }[];
  const hasOldSchema = columns.length > 0 && !columns.some((c) => c.name === "accountEmail");
  if (hasOldSchema) db.exec(`DROP TABLE emails;`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      rowKey TEXT PRIMARY KEY,
      accountEmail TEXT NOT NULL,
      id TEXT NOT NULL,
      threadId TEXT NOT NULL,
      sender TEXT NOT NULL,
      senderEmail TEXT NOT NULL,
      subject TEXT NOT NULL,
      date TEXT NOT NULL,
      snippet TEXT NOT NULL,
      scanned INTEGER NOT NULL DEFAULT 0,
      actionable INTEGER NOT NULL DEFAULT 0,
      needsReply INTEGER NOT NULL DEFAULT 0,
      hasDeadline INTEGER NOT NULL DEFAULT 0,
      deadlineDate TEXT,
      project TEXT,
      itemType TEXT,
      notionPageId TEXT,
      draftId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_emails_scanned ON emails(scanned);
    CREATE INDEX IF NOT EXISTS idx_emails_actionable ON emails(actionable);
    CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
    CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(accountEmail);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecord(row: any): EmailRecord {
  return {
    id: row.id,
    accountEmail: row.accountEmail,
    threadId: row.threadId,
    sender: row.sender,
    senderEmail: row.senderEmail,
    subject: row.subject,
    date: row.date,
    snippet: row.snippet,
    scanned: Boolean(row.scanned),
    actionable: Boolean(row.actionable),
    needsReply: Boolean(row.needsReply),
    hasDeadline: Boolean(row.hasDeadline),
    deadlineDate: row.deadlineDate ?? undefined,
    project: row.project ?? undefined,
    itemType: row.itemType ?? undefined,
    notionPageId: row.notionPageId ?? undefined,
    draftId: row.draftId ?? undefined,
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
export function upsertEmailMetadata(records: EmailMetadataInput[]): void {
  if (records.length === 0) return;
  const stmt = getDb().prepare(`
    INSERT INTO emails (rowKey, accountEmail, id, threadId, sender, senderEmail, subject, date, snippet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rowKey) DO NOTHING
  `);
  for (const r of records) {
    stmt.run(rowKey(r.accountEmail, r.id), r.accountEmail, r.id, r.threadId, r.sender, r.senderEmail, r.subject, r.date, r.snippet);
  }
}

export function getUnscannedEmails(limit: number): EmailRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM emails WHERE scanned = 0 ORDER BY date DESC LIMIT ?`)
    .all(limit);
  return rows.map(toRecord);
}

export function countUnscanned(): number {
  const row = getDb().prepare(`SELECT COUNT(*) as n FROM emails WHERE scanned = 0`).get() as { n: number };
  return row.n;
}

export function countTotal(): number {
  const row = getDb().prepare(`SELECT COUNT(*) as n FROM emails`).get() as { n: number };
  return row.n;
}

export function countFlagged(): number {
  const row = getDb().prepare(`SELECT COUNT(*) as n FROM emails WHERE actionable = 1`).get() as { n: number };
  return row.n;
}

export function getFlaggedEmails(limit = 50): EmailRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM emails WHERE actionable = 1 ORDER BY date DESC LIMIT ?`)
    .all(limit);
  return rows.map(toRecord);
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

export function markScanned(accountEmail: string, id: string, result: ScanResult): void {
  getDb()
    .prepare(
      `UPDATE emails SET scanned = 1, actionable = ?, needsReply = ?, hasDeadline = ?, deadlineDate = ?, project = ?, itemType = ?, notionPageId = ?, draftId = ? WHERE rowKey = ?`
    )
    .run(
      result.actionable ? 1 : 0,
      result.needsReply ? 1 : 0,
      result.hasDeadline ? 1 : 0,
      result.deadlineDate ?? null,
      result.project ?? null,
      result.itemType ?? null,
      result.notionPageId ?? null,
      result.draftId ?? null,
      rowKey(accountEmail, id)
    );
}

/** Cheap local fallback search (subject/sender/snippet) — used only if a live
 * Gmail search can't run (e.g. mid-sync). Prefer gmail.ts's searchMessages otherwise. */
export function searchEmailsLocal(query: string, limit = 5): EmailRecord[] {
  const like = `%${query}%`;
  const rows = getDb()
    .prepare(
      `SELECT * FROM emails WHERE subject LIKE ? OR sender LIKE ? OR snippet LIKE ? ORDER BY date DESC LIMIT ?`
    )
    .all(like, like, like, limit);
  return rows.map(toRecord);
}

/** All cached email metadata, for the data export — same fields as everywhere
 * else in this store (metadata only, never raw bodies). */
export function getAllEmails(): EmailRecord[] {
  const rows = getDb().prepare(`SELECT * FROM emails ORDER BY date DESC`).all();
  return rows.map(toRecord);
}

/** Wipes the entire local Gmail cache — used by the settings "delete
 * everything / disconnect" flow. Does not touch Gmail or Notion themselves. */
export function clearAllEmails(): void {
  getDb().exec(`DELETE FROM emails; DELETE FROM meta;`);
}

/** Clears just one account's cached emails — used when disconnecting a
 * single account (Step 8) rather than the full wipe. */
export function clearEmailsForAccount(accountEmail: string): void {
  getDb().prepare(`DELETE FROM emails WHERE accountEmail = ?`).run(accountEmail);
}

export function getMeta(key: string): string | undefined {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(key: string, value: string): void {
  getDb().prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

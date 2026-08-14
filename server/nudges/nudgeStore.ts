// Tracks only "was a push already sent today for this task" — nothing about
// dismissal or acknowledgement. The in-app nudge list is always re-derived
// live from Notion; this store exists solely to stop repeated Today-screen
// opens from re-pinging the phone for the same still-overdue task on the
// same day. SQLite via node:sqlite, same stand-in pattern as gmailStore.ts.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "nudges.db");

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pushed_nudges (
      task_id TEXT PRIMARY KEY,
      pushed_date TEXT NOT NULL
    );
  `);
  return db;
}

export function shouldPush(taskId: string, todayIso: string): boolean {
  const row = getDb().prepare(`SELECT pushed_date FROM pushed_nudges WHERE task_id = ?`).get(taskId) as
    | { pushed_date: string }
    | undefined;
  return row?.pushed_date !== todayIso;
}

export function recordPush(taskId: string, todayIso: string): void {
  getDb()
    .prepare(
      `INSERT INTO pushed_nudges (task_id, pushed_date) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET pushed_date = excluded.pushed_date`
    )
    .run(taskId, todayIso);
}

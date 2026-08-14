// Tracks only "was a push already sent today for this task" — nothing about
// dismissal or acknowledgement. The in-app nudge list is always re-derived
// live from Notion; this store exists solely to stop repeated Today-screen
// opens from re-pinging the phone for the same still-overdue task on the
// same day. Postgres (server/db.ts) — same database as the Gmail cache.
import { ensureSchema, getSql, type Env } from "../db.js";

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

export async function shouldPush(env: Env, taskId: string, todayIso: string): Promise<boolean> {
  const sql = await db(env);
  const rows = (await sql.query("SELECT pushed_date FROM pushed_nudges WHERE task_id = $1", [taskId])) as {
    pushed_date: string;
  }[];
  return rows[0]?.pushed_date !== todayIso;
}

export async function recordPush(env: Env, taskId: string, todayIso: string): Promise<void> {
  const sql = await db(env);
  await sql.query(
    `INSERT INTO pushed_nudges (task_id, pushed_date) VALUES ($1, $2)
     ON CONFLICT (task_id) DO UPDATE SET pushed_date = excluded.pushed_date`,
    [taskId, todayIso]
  );
}

export interface PushedNudgeRecord {
  taskId: string;
  pushedDate: string;
}

/** All push-throttle rows, for the data export. */
export async function getAllPushedNudges(env: Env): Promise<PushedNudgeRecord[]> {
  const sql = await db(env);
  const rows = (await sql.query("SELECT task_id, pushed_date FROM pushed_nudges")) as {
    task_id: string;
    pushed_date: string;
  }[];
  return rows.map((r) => ({ taskId: r.task_id, pushedDate: r.pushed_date }));
}

/** Wipes the push-throttle state — used by the settings "delete everything /
 * disconnect" flow. Doesn't affect anything in Notion; nudges themselves are
 * always re-derived live from Notion's current task status. */
export async function clearAllPushedNudges(env: Env): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM pushed_nudges");
}

const SNOOZE_MS = 24 * 60 * 60 * 1000;

/** Task ids currently snoozed (snoozed_until still in the future) — one
 * query, used to filter the overdue list before nudges are built/pushed, so
 * a snoozed task is invisible to both the in-app list and ntfy in one place.
 * Not Notion data: this is purely "don't bother me about this one for a
 * day," independent of the task's real status, which stays in Notion. */
export async function getSnoozedTaskIds(env: Env): Promise<Set<string>> {
  const sql = await db(env);
  const rows = (await sql.query("SELECT task_id FROM snoozed_nudges WHERE snoozed_until > now()")) as {
    task_id: string;
  }[];
  return new Set(rows.map((r) => r.task_id));
}

/** Snoozes a nudge for a fixed 1 day — simple by design, no date picker. */
export async function snoozeNudge(env: Env, taskId: string): Promise<void> {
  const sql = await db(env);
  const until = new Date(Date.now() + SNOOZE_MS).toISOString();
  await sql.query(
    `INSERT INTO snoozed_nudges (task_id, snoozed_until) VALUES ($1, $2)
     ON CONFLICT (task_id) DO UPDATE SET snoozed_until = excluded.snoozed_until`,
    [taskId, until]
  );
}

/** Wipes all snooze state — used by the settings "delete everything /
 * disconnect" flow, same as the push-throttle table. */
export async function clearAllSnoozedNudges(env: Env): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM snoozed_nudges");
}

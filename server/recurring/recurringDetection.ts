// Recurring task detection — builds on Improvement 3's confidence-labeling
// idea (every suggestion here is inherently a pattern guess, never a
// verified fact) and reuses the same check-on-open trigger pattern as
// nudges/weekly digest. Two independent behaviors with different frequency
// policies:
//  - Scanning for NEW suggestions is deliberately low-frequency (throttled
//    to once every 7 days automatically, or manual via Settings) — "an
//    occasional helpful observation, not a constant stream."
//  - Rolling an ACCEPTED recurring task to its next instance once the
//    current one is marked Done runs on every check — the user opted in,
//    so there's no reason to delay it.
import { ensureSchema, getSql, type Env } from "../db.js";
import { getAllEmails, type EmailRecord } from "../google/gmailStore.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import type { NotionRepo, TaskRecord } from "../notion/queries.js";
import { getSetting, setSetting } from "../settings/appSettings.js";

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly";
const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 90 };
const CADENCES = Object.keys(CADENCE_DAYS) as Cadence[];

const LAST_SCAN_SETTING_KEY = "recurring_last_scan_at";
const SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS_PER_SCAN = 3;

export interface PendingSuggestion {
  id: string;
  title: string;
  cadence: Cadence;
  reason: string;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function computeNextDue(previousDue: string | undefined, cadenceDays: number): string {
  const base = previousDue ? new Date(previousDue) : new Date();
  base.setDate(base.getDate() + cadenceDays);
  return base.toISOString().slice(0, 10);
}

function buildCandidateText(tasks: TaskRecord[], emails: EmailRecord[]): string | undefined {
  const taskGroups = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    const key = normalizeTitle(t.title);
    if (!taskGroups.has(key)) taskGroups.set(key, []);
    taskGroups.get(key)!.push(t);
  }
  const repeatedTasks = [...taskGroups.values()]
    .filter((list) => list.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 20);

  const senderGroups = new Map<string, EmailRecord[]>();
  for (const e of emails) {
    if (!senderGroups.has(e.senderEmail)) senderGroups.set(e.senderEmail, []);
    senderGroups.get(e.senderEmail)!.push(e);
  }
  const repeatedSenders = [...senderGroups.entries()]
    .filter(([, list]) => list.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20);

  if (repeatedTasks.length === 0 && repeatedSenders.length === 0) return undefined;

  const lines: string[] = [];
  if (repeatedTasks.length > 0) {
    lines.push("Task titles that appear more than once (title: due dates seen):");
    for (const list of repeatedTasks) {
      lines.push(`- "${list[0].title}": ${list.map((t) => t.due ?? "no date").join(", ")}`);
    }
  }
  if (repeatedSenders.length > 0) {
    lines.push("\nEmail senders with more than one message (sender: subjects with dates):");
    for (const [sender, list] of repeatedSenders) {
      const subjects = list
        .slice(0, 8)
        .map((e) => `"${e.subject}" (${e.date.slice(0, 10)})`)
        .join(", ");
      lines.push(`- ${sender}: ${subjects}`);
    }
  }
  return lines.join("\n");
}

const DETECTION_SYSTEM_PROMPT = `You detect genuinely recurring patterns in a personal assistant's task and email history — things that repeat on a regular cadence, like a monthly report, a weekly check-in, a bill paid every quarter. You're given repeated task titles (with the dates they had) and repeated email senders (with their subject lines and dates). Only surface something you're reasonably confident is a real recurring pattern — a task appearing twice isn't necessarily recurring, and neither is a sender who happens to email more than once. When genuinely unsure, output nothing rather than guess. Respond with ONLY a JSON array (no markdown, no commentary), at most 3 items, each: {"title": short task title for the recurring item, "cadence": one of "weekly"|"biweekly"|"monthly"|"quarterly", "reason": one calm, specific sentence explaining the observed pattern}. If nothing qualifies, respond with exactly: []`;

interface RawSuggestion {
  title: string;
  cadence: Cadence;
  reason: string;
}

function isRawSuggestion(value: unknown): value is RawSuggestion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === "string" && typeof v.reason === "string" && CADENCES.includes(v.cadence as Cadence);
}

async function detectCandidates(llmEnv: LlmEnv, candidateText: string): Promise<RawSuggestion[]> {
  let raw: string;
  try {
    raw = await routedComplete(llmEnv, "recurring pattern detection", DETECTION_SYSTEM_PROMPT, candidateText, 500, "claude-haiku-4-5");
  } catch (error) {
    console.error("[recurring] detection call failed:", error);
    return [];
  }

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRawSuggestion).slice(0, MAX_SUGGESTIONS_PER_SCAN);
  } catch (error) {
    console.error("[recurring] couldn't parse model output as JSON:", error, raw);
    return [];
  }
}

async function storeNewSuggestions(env: Env, candidates: RawSuggestion[]): Promise<number> {
  if (candidates.length === 0) return 0;
  const sql = await db(env);
  const existingRows = (await sql.query("SELECT normalized_title FROM recurring_suggestions")) as { normalized_title: string }[];
  const existing = new Set(existingRows.map((r) => r.normalized_title));

  let created = 0;
  for (const c of candidates) {
    const norm = normalizeTitle(c.title);
    if (existing.has(norm)) continue;
    await sql.query(
      `INSERT INTO recurring_suggestions (id, title, normalized_title, cadence, reason, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [crypto.randomUUID(), c.title, norm, c.cadence, c.reason]
    );
    existing.add(norm);
    created++;
  }
  return created;
}

async function shouldAutoScan(env: Env): Promise<boolean> {
  const last = await getSetting(env, LAST_SCAN_SETTING_KEY);
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= SCAN_INTERVAL_MS;
}

/** Scans now regardless of the throttle — backs both the automatic
 * once-a-week check and a manual "Scan now" action in Settings. */
export async function scanForRecurringPatterns(dbEnv: Env, llmEnv: LlmEnv, repo: NotionRepo): Promise<{ created: number }> {
  const [tasks, emails] = await Promise.all([repo.listTasks(), getAllEmails(dbEnv)]);
  await setSetting(dbEnv, LAST_SCAN_SETTING_KEY, new Date().toISOString());

  const candidateText = buildCandidateText(tasks, emails);
  if (!candidateText) return { created: 0 };

  const candidates = await detectCandidates(llmEnv, candidateText);
  const created = await storeNewSuggestions(dbEnv, candidates);
  return { created };
}

interface RecurringTaskRow {
  id: string;
  title: string;
  cadence: string;
  cadence_days: number;
  current_task_id: string;
}

/** For each accepted recurring task whose current Notion instance has been
 * marked Done, creates the next instance and re-points tracking at it.
 * Cheap (one listTasks() call already needed elsewhere), so it runs on
 * every check rather than being throttled. */
async function rolloverCompletedRecurringTasks(dbEnv: Env, repo: NotionRepo, tasks: TaskRecord[]): Promise<void> {
  const sql = await db(dbEnv);
  const rows = (await sql.query("SELECT * FROM recurring_tasks")) as RecurringTaskRow[];
  if (rows.length === 0) return;

  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const row of rows) {
    const current = byId.get(row.current_task_id);
    if (!current || !current.done) continue;

    const nextDue = computeNextDue(current.due, row.cadence_days);
    const created = await repo.createTask(row.title, { due: nextDue });
    await sql.query("UPDATE recurring_tasks SET current_task_id = $1, updated_at = now() WHERE id = $2", [created.id, row.id]);
  }
}

export async function listPendingSuggestions(dbEnv: Env): Promise<PendingSuggestion[]> {
  const sql = await db(dbEnv);
  const rows = (await sql.query(
    "SELECT id, title, cadence, reason FROM recurring_suggestions WHERE status = 'pending' ORDER BY created_at DESC"
  )) as { id: string; title: string; cadence: string; reason: string }[];
  return rows.map((r) => ({ id: r.id, title: r.title, cadence: r.cadence as Cadence, reason: r.reason }));
}

/** Check-on-open entry point: always rolls over any accepted recurring
 * tasks that are due, auto-scans for new suggestions at most once a week,
 * and returns whatever's currently pending. */
export async function checkRecurringTasks(dbEnv: Env, llmEnv: LlmEnv, repo: NotionRepo): Promise<PendingSuggestion[]> {
  const tasks = await repo.listTasks();
  await rolloverCompletedRecurringTasks(dbEnv, repo, tasks).catch((error) => console.error("[recurring] rollover failed:", error));

  if (await shouldAutoScan(dbEnv)) {
    await scanForRecurringPatterns(dbEnv, llmEnv, repo).catch((error) => console.error("[recurring] auto-scan failed:", error));
  }

  return listPendingSuggestions(dbEnv);
}

export async function acceptSuggestion(dbEnv: Env, repo: NotionRepo, suggestionId: string): Promise<void> {
  const sql = await db(dbEnv);
  const rows = (await sql.query("SELECT * FROM recurring_suggestions WHERE id = $1", [suggestionId])) as {
    id: string;
    title: string;
    cadence: string;
  }[];
  const suggestion = rows[0];
  if (!suggestion) throw new Error("Suggestion not found");

  const cadence = (CADENCES.includes(suggestion.cadence as Cadence) ? suggestion.cadence : "monthly") as Cadence;
  const cadenceDays = CADENCE_DAYS[cadence];
  const due = computeNextDue(undefined, cadenceDays);
  const created = await repo.createTask(suggestion.title, { due });

  await sql.query(
    `INSERT INTO recurring_tasks (id, title, cadence, cadence_days, current_task_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [crypto.randomUUID(), suggestion.title, cadence, cadenceDays, created.id]
  );
  await sql.query("UPDATE recurring_suggestions SET status = 'accepted' WHERE id = $1", [suggestionId]);
}

export async function dismissSuggestion(dbEnv: Env, suggestionId: string): Promise<void> {
  const sql = await db(dbEnv);
  await sql.query("UPDATE recurring_suggestions SET status = 'dismissed' WHERE id = $1", [suggestionId]);
}

/** Wipes all recurring-detection state — used by the settings "delete
 * everything / disconnect" flow, same reasoning as weekly_digest: this is
 * derived data, not a source of truth. Tracked recurring Tasks already
 * created in Notion are untouched (Notion stays the source of truth for
 * the tasks themselves — only the tracking/suggestion metadata is local). */
export async function clearAllRecurringData(env: Env): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM recurring_suggestions");
  await sql.query("DELETE FROM recurring_tasks");
}

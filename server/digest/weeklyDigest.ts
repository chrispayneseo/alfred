// Weekly digest — same "check-on-open" trigger pattern as the daily
// nudge check (server/nudges/check.ts): no cron, just re-evaluated whenever
// the client asks. Idempotent per ISO week via the weekly_digest table, so
// re-opening the app doesn't regenerate (or re-push to ntfy) repeatedly.
import { ensureSchema, getSql, type Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { GoogleAccountEnv } from "../google/accounts.js";
import { listEventsAllAccounts, type CalendarEventRecord } from "../google/calendar.js";
import { getFlaggedEmails } from "../google/gmailStore.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import type { NotionRepo, TaskRecord } from "../notion/queries.js";
import { DIGEST_PROJECTS } from "../notion/schema.js";
import type { NtfyEnv } from "../notify/env.js";
import { notify } from "../notify/ntfy.js";
import { getSetting, setSetting } from "../settings/appSettings.js";

export type DigestTriggerDay = "sunday" | "monday";
const TRIGGER_DAY_SETTING_KEY = "weekly_digest_trigger_day";
const DEFAULT_TRIGGER_DAY: DigestTriggerDay = "sunday";
const TRIGGER_DAY_INDEX: Record<DigestTriggerDay, number> = { sunday: 0, monday: 1 };

export async function getDigestTriggerDay(env: Env): Promise<DigestTriggerDay> {
  const value = await getSetting(env, TRIGGER_DAY_SETTING_KEY);
  return value === "monday" ? "monday" : DEFAULT_TRIGGER_DAY;
}

export async function setDigestTriggerDay(env: Env, day: DigestTriggerDay): Promise<void> {
  await setSetting(env, TRIGGER_DAY_SETTING_KEY, day);
}

function isTriggerDayReached(triggerDay: DigestTriggerDay, now: Date): boolean {
  return now.getDay() >= TRIGGER_DAY_INDEX[triggerDay];
}

/** ISO 8601 week key, e.g. "2026-W33" — used purely as an idempotency key
 * (has a new digest already been generated for "this" trigger window), not
 * as an analytical week boundary. The digest's actual content window is
 * always "the next 7 days from generation time," independent of this. */
function getIsoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

export interface WeeklyDigestResult {
  weekKey: string;
  summary: string;
  generatedAt: string;
  isFresh: boolean;
}

export interface WeeklyDigestNotReady {
  available: false;
  triggerDay: DigestTriggerDay;
}

async function getCached(env: Env, weekKey: string): Promise<WeeklyDigestResult | undefined> {
  const sql = await db(env);
  const rows = (await sql.query("SELECT * FROM weekly_digest WHERE week_key = $1", [weekKey])) as {
    week_key: string;
    summary: string;
    generated_at: string;
  }[];
  const row = rows[0];
  if (!row) return undefined;
  return { weekKey: row.week_key, summary: row.summary, generatedAt: new Date(row.generated_at).toISOString(), isFresh: false };
}

function formatEventLine(event: CalendarEventRecord): string {
  const when = event.allDay ? event.start : new Date(event.start).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return `- ${when}: ${event.title}`;
}

function formatTasksByProject(tasks: TaskRecord[]): string {
  const open = tasks.filter((t) => !t.done);
  const lines: string[] = [];
  for (const project of DIGEST_PROJECTS) {
    const forProject = open.filter((t) => t.projectName === project);
    if (forProject.length === 0) continue;
    lines.push(`${project} (${forProject.length}):`);
    for (const t of forProject.slice(0, 8)) {
      lines.push(`  - ${t.title}${t.due ? ` (due ${t.due})` : ""}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No open tasks in any tracked project.";
}

const DIGEST_SYSTEM_PROMPT = `You write a short weekly digest for a personal-assistant app, in the same calm, warm, plain-spoken voice as its daily nudges — never corporate, never a bulleted status report, never alarmist. Synthesize the raw data you're given into a few short readable paragraphs (roughly 120-200 words): what's coming up this week (calendar), what's open across each area of the person's life, anything flagged in email worth a second look, and a one-line note on what got captured/filed this week. Skip a section entirely if it has nothing in it rather than saying "nothing here." No headers, no markdown, plain prose paragraphs, no greeting, no sign-off.`;

async function synthesize(
  dbEnv: Env,
  llmEnv: LlmEnv,
  events: CalendarEventRecord[],
  tasksByProject: string,
  flaggedThisWeek: number,
  captured: { tasks: number; notes: number }
): Promise<string> {
  const userText = [
    `Calendar (next 7 days):\n${events.length > 0 ? events.map(formatEventLine).join("\n") : "Nothing scheduled."}`,
    `Open tasks by area:\n${tasksByProject}`,
    `Emails flagged as needing attention in the last 7 days: ${flaggedThisWeek}`,
    `Captured and filed into Notion this week: ${captured.tasks} task${captured.tasks === 1 ? "" : "s"}, ${captured.notes} note${captured.notes === 1 ? "" : "s"}`,
  ].join("\n\n");

  const result = await routedComplete(llmEnv, "weekly digest personal assistant summary", DIGEST_SYSTEM_PROMPT, userText, 400);
  await logModelCall(dbEnv, {
    provider: result.model,
    feature: "digest",
    model: result.modelId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
  return result.text;
}

/** Check-on-open entry point: returns the cached digest for the current
 * trigger window if one exists, generates a fresh one (and pushes to ntfy)
 * if we're at/past the configured trigger day and none exists yet, or
 * reports "not yet due" otherwise. */
export async function checkWeeklyDigest(
  dbEnv: Env,
  llmEnv: LlmEnv,
  ntfyEnv: NtfyEnv,
  accounts: GoogleAccountEnv[],
  repo: NotionRepo
): Promise<WeeklyDigestResult | WeeklyDigestNotReady> {
  const now = new Date();
  const triggerDay = await getDigestTriggerDay(dbEnv);
  const weekKey = getIsoWeekKey(now);

  const cached = await getCached(dbEnv, weekKey);
  if (cached) return cached;

  if (!isTriggerDayReached(triggerDay, now)) {
    return { available: false, triggerDay };
  }

  return generateAndStore(dbEnv, llmEnv, ntfyEnv, accounts, repo, weekKey);
}

/** Generates immediately regardless of trigger day — backs a manual
 * "generate now" action in-app, and re-generating for the current week key
 * simply overwrites the cached row (so trying it twice in one window is
 * harmless, just redundant work). */
export async function generateWeeklyDigestNow(
  dbEnv: Env,
  llmEnv: LlmEnv,
  ntfyEnv: NtfyEnv,
  accounts: GoogleAccountEnv[],
  repo: NotionRepo
): Promise<WeeklyDigestResult> {
  const weekKey = getIsoWeekKey(new Date());
  return generateAndStore(dbEnv, llmEnv, ntfyEnv, accounts, repo, weekKey);
}

/** Wipes cached digests — used by the settings "delete everything /
 * disconnect" flow, since digest content is derived partly from Google
 * Calendar/Gmail data that flow already disconnects. Leaves the trigger-day
 * preference (app_settings) alone — that's a UI preference, not
 * connected-account data. */
export async function clearAllWeeklyDigests(env: Env): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM weekly_digest");
}

async function generateAndStore(
  dbEnv: Env,
  llmEnv: LlmEnv,
  ntfyEnv: NtfyEnv,
  accounts: GoogleAccountEnv[],
  repo: NotionRepo,
  weekKey: string
): Promise<WeeklyDigestResult> {
  const weekRange = { start: new Date(), end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };

  const [eventsResult, allTasks, flaggedEmails, captured] = await Promise.all([
    accounts.length > 0 ? listEventsAllAccounts(dbEnv, accounts, weekRange).catch(() => ({ events: [], failedAccounts: [] })) : Promise.resolve({ events: [], failedAccounts: [] }),
    repo.listTasks(),
    getFlaggedEmails(dbEnv, 100),
    repo.countRecentlyCaptured(),
  ]);

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const flaggedThisWeek = flaggedEmails.filter((e) => new Date(e.date).getTime() >= sevenDaysAgo).length;
  const tasksByProject = formatTasksByProject(allTasks);

  const summary = await synthesize(dbEnv, llmEnv, eventsResult.events, tasksByProject, flaggedThisWeek, captured);

  const sql = await db(dbEnv);
  await sql.query(
    `INSERT INTO weekly_digest (week_key, summary, generated_at) VALUES ($1, $2, now())
     ON CONFLICT (week_key) DO UPDATE SET summary = excluded.summary, generated_at = now()`,
    [weekKey, summary]
  );

  if (ntfyEnv.topic) {
    await notify(ntfyEnv.topic, summary, "Your weekly digest").catch((error) =>
      console.error("[weeklyDigest] ntfy push failed:", error)
    );
  }

  return { weekKey, summary, generatedAt: new Date().toISOString(), isFresh: true };
}

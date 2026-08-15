// Auto-suggested project groupings — extends the recurring-task-detection
// pattern (same check-on-open trigger, same low-frequency weekly throttle,
// same explicit accept/dismiss requirement, same "reuse the INFERRED label"
// idea from the confidence-flagged-answers work) to a different kind of
// pattern: clusters of captured Tasks/Notes that share a theme but don't
// fit neatly under an existing Project.
import { ensureSchema, getSql, type Env } from "../db.js";
import { logModelCall } from "../costTracking/callLog.js";
import type { LlmEnv } from "../llm/env.js";
import { routedComplete } from "../llm/routedComplete.js";
import type { NotionRepo } from "../notion/queries.js";
import { getSetting, setSetting } from "../settings/appSettings.js";

const LAST_SCAN_SETTING_KEY = "project_grouping_last_scan_at";
const SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS_PER_SCAN = 2;
const MAX_CANDIDATE_ITEMS = 60;

export interface GroupingItem {
  id: string;
  kind: "task" | "note";
  title: string;
}

export interface PendingGrouping {
  id: string;
  suggestedName: string;
  reason: string;
  items: GroupingItem[];
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildCandidateText(tasks: { id: string; title: string; projectName?: string }[], notes: { id: string; title: string; projectName?: string }[]): string | undefined {
  const taskLines = tasks
    .slice(0, MAX_CANDIDATE_ITEMS)
    .map((t) => `- id:${t.id} kind:task project:${t.projectName ?? "none"} title:"${t.title}"`);
  const noteLines = notes
    .slice(0, MAX_CANDIDATE_ITEMS)
    .map((n) => `- id:${n.id} kind:note project:${n.projectName ?? "none"} title:"${n.title}"`);

  if (taskLines.length === 0 && noteLines.length === 0) return undefined;
  return [...taskLines, ...noteLines].join("\n");
}

const GROUPING_SYSTEM_PROMPT = `You look for clusters of related captured items (tasks and notes) in a personal assistant app that share a clear common theme but aren't well served by any existing Project. Existing Projects: Job, Freelance, Personal, Football Coaching, Side Projects, Unsorted.

Only surface a genuine cluster: at least 2 items (ideally 3+) that clearly share a specific theme distinct from what an existing Project already covers well. Don't suggest grouping items that already fit an existing Project fine — "Unsorted" items in particular are only worth grouping if several of them share one clear specific theme, not just because they're unsorted. When unsure, suggest nothing.

Respond with ONLY a JSON array (no markdown, no commentary), at most 2 items, each: {"name": short suggested Project name, "reason": one calm, specific sentence naming the shared theme, "itemIds": [the "id" values of the items that belong in this group, from the list you were given]}. If nothing qualifies, respond with exactly: []`;

interface RawGrouping {
  name: string;
  reason: string;
  itemIds: string[];
}

function isRawGrouping(value: unknown): value is RawGrouping {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    v.name.trim().length > 0 &&
    typeof v.reason === "string" &&
    Array.isArray(v.itemIds) &&
    v.itemIds.length >= 2 &&
    v.itemIds.every((id) => typeof id === "string")
  );
}

async function detectGroupings(dbEnv: Env, llmEnv: LlmEnv, candidateText: string): Promise<RawGrouping[]> {
  let raw: string;
  try {
    const result = await routedComplete(llmEnv, "project grouping detection", GROUPING_SYSTEM_PROMPT, candidateText, 600, "claude-haiku-4-5");
    raw = result.text;
    await logModelCall(dbEnv, {
      provider: result.model,
      feature: "project_grouping",
      model: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  } catch (error) {
    console.error("[projectGroupings] detection call failed:", error);
    return [];
  }

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRawGrouping).slice(0, MAX_SUGGESTIONS_PER_SCAN);
  } catch (error) {
    console.error("[projectGroupings] couldn't parse model output as JSON:", error, raw);
    return [];
  }
}

async function storeNewSuggestions(
  env: Env,
  candidates: RawGrouping[],
  tasksById: Map<string, string>,
  notesById: Map<string, string>
): Promise<number> {
  if (candidates.length === 0) return 0;
  const sql = await db(env);
  const existingRows = (await sql.query("SELECT normalized_name FROM project_grouping_suggestions")) as {
    normalized_name: string;
  }[];
  const existing = new Set(existingRows.map((r) => r.normalized_name));

  let created = 0;
  for (const c of candidates) {
    const norm = normalizeName(c.name);
    if (existing.has(norm)) continue;

    // Resolve each model-cited id back to a real task/note we actually
    // offered it — drops anything hallucinated rather than trusting it.
    const items: GroupingItem[] = c.itemIds.flatMap((id): GroupingItem[] => {
      if (tasksById.has(id)) return [{ id, kind: "task", title: tasksById.get(id)! }];
      if (notesById.has(id)) return [{ id, kind: "note", title: notesById.get(id)! }];
      return [];
    });
    if (items.length < 2) continue;

    await sql.query(
      `INSERT INTO project_grouping_suggestions (id, suggested_name, normalized_name, reason, items, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [crypto.randomUUID(), c.name, norm, c.reason, JSON.stringify(items)]
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
export async function scanForProjectGroupings(dbEnv: Env, llmEnv: LlmEnv, repo: NotionRepo): Promise<{ created: number }> {
  const [tasks, notes] = await Promise.all([repo.listTasks(), repo.listNotes()]);
  await setSetting(dbEnv, LAST_SCAN_SETTING_KEY, new Date().toISOString());

  const candidateText = buildCandidateText(tasks, notes);
  if (!candidateText) return { created: 0 };

  const candidates = await detectGroupings(dbEnv, llmEnv, candidateText);
  const tasksById = new Map(tasks.slice(0, MAX_CANDIDATE_ITEMS).map((t) => [t.id, t.title]));
  const notesById = new Map(notes.slice(0, MAX_CANDIDATE_ITEMS).map((n) => [n.id, n.title]));
  const created = await storeNewSuggestions(dbEnv, candidates, tasksById, notesById);
  return { created };
}

interface SuggestionRow {
  id: string;
  suggested_name: string;
  reason: string;
  items: string;
}

function toPending(row: SuggestionRow): PendingGrouping {
  return { id: row.id, suggestedName: row.suggested_name, reason: row.reason, items: JSON.parse(row.items) };
}

export async function listPendingGroupings(dbEnv: Env): Promise<PendingGrouping[]> {
  const sql = await db(dbEnv);
  const rows = (await sql.query(
    "SELECT id, suggested_name, reason, items FROM project_grouping_suggestions WHERE status = 'pending' ORDER BY created_at DESC"
  )) as SuggestionRow[];
  return rows.map(toPending);
}

/** Check-on-open entry point: auto-scans for new suggestions at most once a
 * week, returns whatever's currently pending. No rollover concept here
 * (unlike recurring tasks) — there's no ongoing tracked state, just
 * suggest/accept/dismiss. */
export async function checkProjectGroupings(dbEnv: Env, llmEnv: LlmEnv, repo: NotionRepo): Promise<PendingGrouping[]> {
  if (await shouldAutoScan(dbEnv)) {
    await scanForProjectGroupings(dbEnv, llmEnv, repo).catch((error) => console.error("[projectGroupings] auto-scan failed:", error));
  }
  return listPendingGroupings(dbEnv);
}

export async function acceptGrouping(dbEnv: Env, repo: NotionRepo, suggestionId: string): Promise<void> {
  const sql = await db(dbEnv);
  const rows = (await sql.query("SELECT * FROM project_grouping_suggestions WHERE id = $1", [suggestionId])) as SuggestionRow[];
  const row = rows[0];
  if (!row) throw new Error("Suggestion not found");

  const items: GroupingItem[] = JSON.parse(row.items);
  const project = await repo.createProject(row.suggested_name);

  await Promise.all(
    items.map((item) => (item.kind === "task" ? repo.setTaskProject(item.id, project.id) : repo.setNoteProject(item.id, project.id)))
  );

  await sql.query("UPDATE project_grouping_suggestions SET status = 'accepted' WHERE id = $1", [suggestionId]);
}

export async function dismissGrouping(dbEnv: Env, suggestionId: string): Promise<void> {
  const sql = await db(dbEnv);
  await sql.query("UPDATE project_grouping_suggestions SET status = 'dismissed' WHERE id = $1", [suggestionId]);
}

/** Wipes all grouping-suggestion state — used by the settings "delete
 * everything / disconnect" flow, same reasoning as recurring_suggestions:
 * this is derived data, not a source of truth. Any Project already created
 * from an accepted suggestion stays in Notion untouched. */
export async function clearAllProjectGroupings(env: Env): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM project_grouping_suggestions");
}

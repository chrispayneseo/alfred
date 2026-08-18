// Check-on-open entry point for the Leeds ticket-window countdown — same
// shape as the news feed / project groupings / recurring-task checks: a
// throttled auto-scan, then return whatever's currently tracked. The scan
// throttle is short (10 min) rather than daily/weekly, since this is meant
// to feel live on every Today open, not a once-a-day digest.
import { ensureSchema, getSql, type Env } from "../db.js";
import type { GoogleAccountEnv } from "../google/accounts.js";
import type { LlmEnv } from "../llm/env.js";
import type { NtfyEnv } from "../notify/env.js";
import { getSetting, setSetting } from "../settings/appSettings.js";
import { scanLeedsTicketEmails } from "./extract.js";
import { checkLeedsTicketNudges } from "./nudges.js";
import { getLeedsTicketSettings, type MembershipTier } from "./settings.js";

const LAST_SCAN_SETTING_KEY = "leeds_ticket_last_scan_at";
const SCAN_INTERVAL_MS = 10 * 60 * 1000;

export interface TicketWindow {
  id: string;
  opponent: string;
  homeAway: "H" | "A";
  phaseLabel: string;
  phaseKind: "direct_sale" | "ballot_application";
  opensAt: string;
  closesAt?: string;
}

export interface ReviewWindow {
  id: string;
  opponent: string;
  homeAway: "H" | "A";
  phaseLabel: string;
  note: string;
  gmailRowKey: string;
}

export interface LeedsTicketsState {
  windows: TicketWindow[];
  review: ReviewWindow[];
  tier: MembershipTier;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

interface WindowRow {
  id: string;
  opponent: string;
  home_away: string;
  phase_label: string;
  phase_kind: string;
  window_opens_at: string;
  window_closes_at: string | null;
  eligibility_status: string;
  eligibility_note: string | null;
  gmail_row_key: string;
}

function shouldAutoScan(env: Env): Promise<boolean> {
  return getSetting(env, LAST_SCAN_SETTING_KEY).then((last) => !last || Date.now() - new Date(last).getTime() >= SCAN_INTERVAL_MS);
}

async function listRows(env: Env): Promise<WindowRow[]> {
  const sql = await db(env);
  return (await sql.query(
    `SELECT id, opponent, home_away, phase_label, phase_kind, window_opens_at, window_closes_at, eligibility_status, eligibility_note, gmail_row_key
     FROM leeds_ticket_windows
     WHERE status = 'pending'
     ORDER BY COALESCE(window_closes_at, window_opens_at) ASC`
  )) as WindowRow[];
}

function toState(rows: WindowRow[], tier: MembershipTier): LeedsTicketsState {
  const windows: TicketWindow[] = [];
  const review: ReviewWindow[] = [];
  for (const row of rows) {
    if (row.eligibility_status === "needs_review") {
      review.push({
        id: row.id,
        opponent: row.opponent,
        homeAway: row.home_away === "A" ? "A" : "H",
        phaseLabel: row.phase_label,
        note: row.eligibility_note ?? "Couldn't confirm eligibility from the email.",
        gmailRowKey: row.gmail_row_key,
      });
    } else {
      windows.push({
        id: row.id,
        opponent: row.opponent,
        homeAway: row.home_away === "A" ? "A" : "H",
        phaseLabel: row.phase_label,
        phaseKind: row.phase_kind === "ballot_application" ? "ballot_application" : "direct_sale",
        opensAt: new Date(row.window_opens_at).toISOString(),
        closesAt: row.window_closes_at ? new Date(row.window_closes_at).toISOString() : undefined,
      });
    }
  }
  return { windows, review, tier };
}

/** Auto-scans (if due) and checks nudges, then returns the current
 * countdown + needs-review lists. Called on every Today load. */
export async function checkLeedsTickets(
  dbEnv: Env,
  llmEnv: LlmEnv,
  ntfyEnv: NtfyEnv,
  accounts: GoogleAccountEnv[]
): Promise<LeedsTicketsState> {
  const settings = await getLeedsTicketSettings(dbEnv);

  if (accounts.length > 0 && (await shouldAutoScan(dbEnv))) {
    await setSetting(dbEnv, LAST_SCAN_SETTING_KEY, new Date().toISOString());
    await scanLeedsTicketEmails(dbEnv, llmEnv, accounts, settings.tier);
  }

  await checkLeedsTicketNudges(dbEnv, ntfyEnv, settings);

  return toState(await listRows(dbEnv), settings.tier);
}

export async function actionTicketWindow(env: Env, id: string): Promise<void> {
  const sql = await db(env);
  await sql.query("UPDATE leeds_ticket_windows SET status = 'actioned' WHERE id = $1", [id]);
}

export async function dismissReviewWindow(env: Env, id: string): Promise<void> {
  const sql = await db(env);
  await sql.query("UPDATE leeds_ticket_windows SET status = 'dismissed' WHERE id = $1", [id]);
}

/** Wipes tracked windows and scan-tracking — used by the settings "delete
 * everything / disconnect" flow, since this feature is entirely derived
 * from Gmail data. Deliberately leaves the tier/nudge-timing preferences
 * (app_settings) alone — those are UI preferences, not connected-account data. */
export async function clearAllLeedsTickets(env: Env): Promise<void> {
  const sql = await db(env);
  await sql.query("DELETE FROM leeds_ticket_windows");
  await sql.query("DELETE FROM leeds_scanned_emails");
}

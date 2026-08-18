// Three-stage ntfy nudge sequence per tracked ticket-window phase: an early
// heads-up, a closer reminder, and a distinct push exactly when the window
// (or ballot deadline) is reached. All three fire relative to a single
// "target" instant per phase — window_closes_at for a ballot (the deadline
// to apply) or window_opens_at for a direct sale (when tickets go live) —
// since that's the moment the user actually needs to act by.
import { ensureSchema, getSql, type Env } from "../db.js";
import type { NtfyEnv } from "../notify/env.js";
import { notify } from "../notify/ntfy.js";
import type { LeedsTicketSettings } from "./settings.js";

interface WindowRow {
  id: string;
  opponent: string;
  home_away: string;
  phase_label: string;
  phase_kind: string;
  window_opens_at: string;
  window_closes_at: string | null;
  nudge_early_sent: boolean;
  nudge_close_sent: boolean;
  nudge_open_sent: boolean;
}

async function db(env: Env) {
  await ensureSchema(env);
  return getSql(env);
}

function fixtureLabel(row: WindowRow): string {
  return `${row.opponent} (${row.home_away})`;
}

function targetAt(row: WindowRow): Date {
  return new Date(row.window_closes_at ?? row.window_opens_at);
}

function earlyMessage(row: WindowRow): string {
  return row.phase_kind === "ballot_application"
    ? `Ballot closes soon for ${fixtureLabel(row)} — ${row.phase_label}. Apply if you haven't.`
    : `Tickets open soon for ${fixtureLabel(row)} — ${row.phase_label}.`;
}

function openMessage(row: WindowRow): string {
  return row.phase_kind === "ballot_application"
    ? `Ballot has closed for ${fixtureLabel(row)} — ${row.phase_label}.`
    : `Tickets are on sale now for ${fixtureLabel(row)} — ${row.phase_label}!`;
}

/** Evaluates every pending window against the configured nudge timings and
 * fires whichever thresholds have newly been crossed since the last check —
 * each stage only ever fires once, tracked by its own boolean flag, so
 * re-running this (on every Today load, or from the cron endpoint) is safe.
 * Never throws — a nudge-delivery failure shouldn't block anything else. */
export async function checkLeedsTicketNudges(env: Env, ntfyEnv: NtfyEnv, settings: LeedsTicketSettings): Promise<void> {
  if (!ntfyEnv.topic) return;

  try {
    const sql = await db(env);
    const rows = (await sql.query(
      `SELECT id, opponent, home_away, phase_label, phase_kind, window_opens_at, window_closes_at,
              nudge_early_sent, nudge_close_sent, nudge_open_sent
       FROM leeds_ticket_windows
       WHERE status = 'pending' AND eligibility_status = 'eligible'`
    )) as WindowRow[];

    const now = Date.now();

    for (const row of rows) {
      const target = targetAt(row).getTime();
      const earlyThreshold = target - settings.earlyNudgeHours * 60 * 60 * 1000;
      const closeThreshold = target - settings.closeNudgeHours * 60 * 60 * 1000;

      if (!row.nudge_early_sent && now >= earlyThreshold && now < target) {
        await notify(ntfyEnv.topic, earlyMessage(row), "Leeds tickets");
        await sql.query("UPDATE leeds_ticket_windows SET nudge_early_sent = true WHERE id = $1", [row.id]);
      }
      if (!row.nudge_close_sent && now >= closeThreshold && now < target) {
        await notify(ntfyEnv.topic, earlyMessage(row), "Leeds tickets");
        await sql.query("UPDATE leeds_ticket_windows SET nudge_close_sent = true WHERE id = $1", [row.id]);
      }
      if (!row.nudge_open_sent && now >= target) {
        await notify(ntfyEnv.topic, openMessage(row), "Leeds tickets");
        await sql.query("UPDATE leeds_ticket_windows SET nudge_open_sent = true WHERE id = $1", [row.id]);
      }
    }
  } catch (error) {
    console.error("[leedsTickets] nudge check failed:", error);
  }
}

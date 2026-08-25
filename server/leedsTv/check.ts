// Check-on-open entry point for the Leeds "on TV" fixture list — same
// throttled-refresh-then-return shape as leedsTickets/check.ts, but backed
// by a single cached JSON blob in app_settings rather than a table: this
// list is fully derived from a page fetch each refresh (no per-row user
// actions, no history to keep), so there's nothing a dedicated table would
// buy here. The throttle is a day, matching the source page's own pace —
// it's a fixture/broadcast list that changes at most a few times a week.
import type { Env } from "../db.js";
import type { LlmEnv } from "../llm/env.js";
import { getSetting, setSetting } from "../settings/appSettings.js";
import { fetchLeedsTvFixtures, type TvFixture } from "./fetchFixtures.js";

const FIXTURES_SETTING_KEY = "leeds_tv_fixtures";
const LAST_CHECK_SETTING_KEY = "leeds_tv_last_checked_at";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_FIXTURES = 4;

async function shouldRefresh(env: Env): Promise<boolean> {
  const last = await getSetting(env, LAST_CHECK_SETTING_KEY);
  return !last || Date.now() - new Date(last).getTime() >= CHECK_INTERVAL_MS;
}

function isTvFixture(value: unknown): value is TvFixture {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.opponent === "string" &&
    (v.homeAway === "H" || v.homeAway === "A") &&
    typeof v.competition === "string" &&
    typeof v.channel === "string" &&
    typeof v.kickoffAt === "string"
  );
}

async function readCached(env: Env): Promise<TvFixture[]> {
  const raw = await getSetting(env, FIXTURES_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTvFixture) : [];
  } catch {
    return [];
  }
}

function futureOnly(fixtures: TvFixture[]): TvFixture[] {
  const nowMs = Date.now();
  return fixtures
    .filter((f) => new Date(f.kickoffAt).getTime() > nowMs)
    .sort((a, b) => new Date(a.kickoffAt).getTime() - new Date(b.kickoffAt).getTime())
    .slice(0, MAX_FIXTURES);
}

/** Refreshes (if due) and returns the next few Leeds fixtures confirmed for
 * UK TV, nearest first. Never throws — a fetch/extraction failure just means
 * whatever was already cached (possibly nothing) is returned, same as other
 * check-on-open features on Today. */
export async function checkLeedsTvFixtures(dbEnv: Env, llmEnv: LlmEnv): Promise<TvFixture[]> {
  if (await shouldRefresh(dbEnv)) {
    await setSetting(dbEnv, LAST_CHECK_SETTING_KEY, new Date().toISOString());
    const fixtures = await fetchLeedsTvFixtures(dbEnv, llmEnv);
    // A failure returns [] — only overwrite the cache when the fetch
    // actually produced something, so a transient failure doesn't blank
    // out a still-valid previous result.
    if (fixtures.length > 0) {
      await setSetting(dbEnv, FIXTURES_SETTING_KEY, JSON.stringify(fixtures));
    }
  }

  return futureOnly(await readCached(dbEnv));
}

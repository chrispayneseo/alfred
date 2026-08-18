// Membership tier + nudge timing preferences for the Leeds ticket-window
// countdown — small app_settings-backed values, editable in Settings rather
// than hardcoded, since the user's tier can change season to season and the
// nudge timings are explicitly meant to be tuned after seeing them in practice.
import type { Env } from "../db.js";
import { getSetting, setSetting } from "../settings/appSettings.js";

export const MEMBERSHIP_TIERS = ["base", "plus", "priority"] as const;
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

export const TIER_LABELS: Record<MembershipTier, string> = {
  base: "My Leeds Members",
  plus: "My Leeds+",
  priority: "My Leeds Priority",
};

// Confirmed from the user's actual 2026/27 membership confirmation email
// ("My Leeds+ Membership") — a sensible out-of-the-box default, not a value
// that needs to be set before the feature works.
const DEFAULT_TIER: MembershipTier = "plus";
const DEFAULT_EARLY_HOURS = 24;
const DEFAULT_CLOSE_HOURS = 2;

const TIER_KEY = "leeds_membership_tier";
const EARLY_HOURS_KEY = "leeds_nudge_early_hours";
const CLOSE_HOURS_KEY = "leeds_nudge_close_hours";

function isMembershipTier(value: string | undefined): value is MembershipTier {
  return MEMBERSHIP_TIERS.includes(value as MembershipTier);
}

export interface LeedsTicketSettings {
  tier: MembershipTier;
  earlyNudgeHours: number;
  closeNudgeHours: number;
}

export async function getLeedsTicketSettings(env: Env): Promise<LeedsTicketSettings> {
  const [tierRaw, earlyRaw, closeRaw] = await Promise.all([
    getSetting(env, TIER_KEY),
    getSetting(env, EARLY_HOURS_KEY),
    getSetting(env, CLOSE_HOURS_KEY),
  ]);
  return {
    tier: isMembershipTier(tierRaw) ? tierRaw : DEFAULT_TIER,
    earlyNudgeHours: earlyRaw ? Number(earlyRaw) : DEFAULT_EARLY_HOURS,
    closeNudgeHours: closeRaw ? Number(closeRaw) : DEFAULT_CLOSE_HOURS,
  };
}

export async function setLeedsTicketSettings(env: Env, settings: LeedsTicketSettings): Promise<void> {
  await Promise.all([
    setSetting(env, TIER_KEY, settings.tier),
    setSetting(env, EARLY_HOURS_KEY, String(settings.earlyNudgeHours)),
    setSetting(env, CLOSE_HOURS_KEY, String(settings.closeNudgeHours)),
  ]);
}

import type { Env } from "../db.js";
import type { NtfyEnv } from "../notify/env.js";
import { notify } from "../notify/ntfy.js";
import { markAlertSent, wasAlertSent } from "./callLog.js";
import { getCostDashboard } from "./dashboard.js";
import type { CostTrackingEnv } from "./env.js";

const PROVIDER_LABEL = { claude: "Anthropic", chatgpt: "OpenAI" } as const;

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Checks each provider's spend against its cap and alert threshold — fires
 * at most once per provider per calendar month no matter how often this
 * runs (the gmail-refresh cron calls it every 30 min). Informational, not
 * alarming: one calm push when a threshold is genuinely crossed, never
 * repeated nagging for the rest of the month. */
export async function checkCostAlerts(dbEnv: Env, costEnv: CostTrackingEnv, ntfyEnv: NtfyEnv): Promise<void> {
  if (!ntfyEnv.topic) return;
  const dashboard = await getCostDashboard(dbEnv, costEnv);
  const key = monthKey(new Date());

  for (const provider of dashboard.providers) {
    if (provider.percentOfCap === undefined || provider.percentOfCap < costEnv.alertThresholdPct) continue;
    if (await wasAlertSent(dbEnv, provider.provider, key)) continue;

    const label = PROVIDER_LABEL[provider.provider];
    const spend = provider.spendUsd?.toFixed(2) ?? "?";
    const cap = provider.capUsd?.toFixed(2) ?? "?";
    await notify(
      ntfyEnv.topic,
      `${label} spend is $${spend} of your $${cap} monthly cap (${Math.round(provider.percentOfCap)}%).`,
      `${label} nearing monthly cap`
    );
    await markAlertSent(dbEnv, provider.provider, key);
  }
}

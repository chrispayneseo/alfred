import type { Env } from "../db.js";
import { fetchAnthropicMonthlyCostUsd } from "./anthropicUsage.js";
import { getFeatureShares, type ModelFeature, type ModelProvider } from "./callLog.js";
import type { CostTrackingEnv } from "./env.js";
import { fetchOpenAiMonthlyCostUsd } from "./openaiUsage.js";

export interface ProviderCostSummary {
  provider: ModelProvider;
  configured: boolean;
  spendUsd?: number;
  capUsd?: number;
  percentOfCap?: number;
  error?: string;
}

export interface FeatureBreakdownEntry {
  feature: ModelFeature;
  claudeTokens: number;
  chatgptTokens: number;
  /** Estimate only — provider APIs can't attribute spend to Alfred's own
   * feature categories, so this scales the provider's real monthly spend
   * proportionally by this feature's share of that provider's total tokens
   * this month (from Alfred's own call log). Undefined when the provider's
   * real spend isn't available (no admin key, or the call failed). */
  claudeEstimatedUsd?: number;
  chatgptEstimatedUsd?: number;
}

export interface CostDashboard {
  generatedAt: string;
  providers: ProviderCostSummary[];
  featureBreakdown: FeatureBreakdownEntry[];
  modelComparison: { claudeTokens: number; chatgptTokens: number };
  /** The % of cap that triggers the proactive ntfy alert — surfaced so the
   * UI can visually flag a provider approaching it, same threshold the
   * cron's checkCostAlerts() uses. */
  alertThresholdPct: number;
}

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function summarizeProvider(
  provider: ModelProvider,
  adminKey: string,
  capUsd: number | undefined,
  since: Date,
  fetchCost: (adminKey: string, since: Date) => Promise<number>
): Promise<ProviderCostSummary> {
  if (!adminKey) return { provider, configured: false, capUsd };
  try {
    const spendUsd = await fetchCost(adminKey, since);
    const percentOfCap = capUsd ? (spendUsd / capUsd) * 100 : undefined;
    return { provider, configured: true, spendUsd, capUsd, percentOfCap };
  } catch (error) {
    console.error(`[costTracking] failed to fetch ${provider} spend:`, error);
    return { provider, configured: true, capUsd, error: error instanceof Error ? error.message : "Couldn't fetch spend." };
  }
}

/** Assembles the whole Settings cost dashboard in one call: real spend vs
 * cap per provider (from each provider's Admin API, when configured), plus
 * an estimated per-feature breakdown scaled from Alfred's own call log
 * (server/costTracking/callLog.ts) — the only source that knows which
 * feature made which call. */
export async function getCostDashboard(dbEnv: Env, costEnv: CostTrackingEnv): Promise<CostDashboard> {
  const since = startOfCurrentMonthUtc();

  const [claudeSummary, chatgptSummary, shares] = await Promise.all([
    summarizeProvider("claude", costEnv.anthropicAdminKey, costEnv.anthropicMonthlyCapUsd, since, fetchAnthropicMonthlyCostUsd),
    summarizeProvider("chatgpt", costEnv.openaiAdminKey, costEnv.openaiMonthlyCapUsd, since, fetchOpenAiMonthlyCostUsd),
    getFeatureShares(dbEnv, since),
  ]);

  const claudeTotalTokens = shares.filter((s) => s.provider === "claude").reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0);
  const chatgptTotalTokens = shares.filter((s) => s.provider === "chatgpt").reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0);

  const byFeature = new Map<ModelFeature, { claudeTokens: number; chatgptTokens: number }>();
  for (const s of shares) {
    const entry = byFeature.get(s.feature) ?? { claudeTokens: 0, chatgptTokens: 0 };
    const tokens = s.inputTokens + s.outputTokens;
    if (s.provider === "claude") entry.claudeTokens += tokens;
    else entry.chatgptTokens += tokens;
    byFeature.set(s.feature, entry);
  }

  const featureBreakdown: FeatureBreakdownEntry[] = [...byFeature.entries()].map(([feature, tokens]) => ({
    feature,
    ...tokens,
    claudeEstimatedUsd:
      claudeSummary.spendUsd !== undefined && claudeTotalTokens > 0
        ? claudeSummary.spendUsd * (tokens.claudeTokens / claudeTotalTokens)
        : undefined,
    chatgptEstimatedUsd:
      chatgptSummary.spendUsd !== undefined && chatgptTotalTokens > 0
        ? chatgptSummary.spendUsd * (tokens.chatgptTokens / chatgptTotalTokens)
        : undefined,
  }));

  return {
    generatedAt: new Date().toISOString(),
    providers: [claudeSummary, chatgptSummary],
    featureBreakdown,
    modelComparison: { claudeTokens: claudeTotalTokens, chatgptTokens: chatgptTotalTokens },
    alertThresholdPct: costEnv.alertThresholdPct,
  };
}

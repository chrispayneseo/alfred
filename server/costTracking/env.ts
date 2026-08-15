export interface CostTrackingEnv {
  anthropicAdminKey: string;
  openaiAdminKey: string;
  anthropicMonthlyCapUsd: number | undefined;
  openaiMonthlyCapUsd: number | undefined;
  alertThresholdPct: number;
}

const DEFAULT_ALERT_THRESHOLD_PCT = 80;

function parseUsd(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Takes a raw env source rather than loading one itself — see
 * google/env.ts for why (dev uses Vite's loadEnv(), prod uses process.env).
 * Admin keys are separate credentials from ANTHROPIC_API_KEY/OPENAI_API_KEY
 * (server/llm/env.ts) — those are regular keys for Messages/Chat calls,
 * these are org-admin-scoped keys for the Usage & Cost reporting APIs,
 * created by an org admin in each provider's console. Neither provider
 * exposes a configured monthly spend cap via API, so the caps here are
 * just what the user tells us — not fetched from anywhere. */
export function loadCostTrackingEnv(source: Record<string, string | undefined>): CostTrackingEnv {
  return {
    anthropicAdminKey: source.ANTHROPIC_ADMIN_KEY ?? "",
    openaiAdminKey: source.OPENAI_ADMIN_KEY ?? "",
    anthropicMonthlyCapUsd: parseUsd(source.ANTHROPIC_MONTHLY_CAP_USD),
    openaiMonthlyCapUsd: parseUsd(source.OPENAI_MONTHLY_CAP_USD),
    alertThresholdPct: parseUsd(source.COST_ALERT_THRESHOLD_PCT) ?? DEFAULT_ALERT_THRESHOLD_PCT,
  };
}

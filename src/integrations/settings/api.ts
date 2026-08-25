export async function fetchExport(): Promise<unknown> {
  const res = await fetch("/api/settings/export");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export interface IntegrationStatus {
  notion: boolean;
  anthropic: boolean;
  openai: boolean;
  coachplan: boolean;
  ntfy: boolean;
}

export async function fetchIntegrationStatus(): Promise<IntegrationStatus> {
  const res = await fetch("/api/settings/integration-status");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export interface ProviderCostSummary {
  provider: "claude" | "chatgpt";
  configured: boolean;
  spendUsd?: number;
  capUsd?: number;
  percentOfCap?: number;
  error?: string;
}

export type ModelFeature =
  | "chat"
  | "capture"
  | "gmail_scan_classify"
  | "gmail_scan_reply"
  | "photo_extraction"
  | "nudges"
  | "digest"
  | "recurring_detection"
  | "project_grouping"
  | "search_console_query"
  | "recipe_extraction"
  | "meal_plan_scaling"
  | "evie_scan_classify"
  | "news_feed_search"
  | "news_feed_curation"
  | "news_feed_newsletter_scan"
  | "news_topic_suggestion"
  | "leeds_ticket_extraction"
  | "leeds_tv_extraction";

export interface FeatureBreakdownEntry {
  feature: ModelFeature;
  claudeTokens: number;
  chatgptTokens: number;
  claudeEstimatedUsd?: number;
  chatgptEstimatedUsd?: number;
}

export interface CostDashboard {
  generatedAt: string;
  providers: ProviderCostSummary[];
  featureBreakdown: FeatureBreakdownEntry[];
  modelComparison: { claudeTokens: number; chatgptTokens: number };
  alertThresholdPct: number;
}

export async function fetchCostDashboard(): Promise<CostDashboard> {
  const res = await fetch("/api/settings/cost-dashboard");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function wipeEverything(): Promise<void> {
  const res = await fetch("/api/settings/wipe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "delete" }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
}

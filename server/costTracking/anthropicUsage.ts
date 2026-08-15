// Anthropic's Usage & Cost Admin API — a completely separate credential and
// surface from the regular Messages API used elsewhere in this app (see
// server/llm/anthropic.ts). Requires an Admin API key (sk-ant-admin01-...),
// created by an org admin in Console → Settings → Admin keys; the regular
// ANTHROPIC_API_KEY has no access to these endpoints. Raw fetch rather than
// the SDK, since the SDK's Admin API surface doesn't cover usage/cost
// reporting as of this writing.
const BASE_URL = "https://api.anthropic.com/v1/organizations";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicUsageResult {
  model: string | null;
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

interface AnthropicCostResult {
  amount: string;
  model: string | null;
}

async function adminFetch<T>(path: string, params: URLSearchParams, adminKey: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}?${params.toString()}`, {
    headers: { "anthropic-version": ANTHROPIC_VERSION, "x-api-key": adminKey },
  });
  if (!res.ok) throw new Error(`Anthropic Admin API ${path} failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Pages through `page`/`next_page`, collecting every bucket's `results`. */
async function collectAllResults<TResult>(
  path: string,
  baseParams: URLSearchParams,
  adminKey: string,
  extract: (bucket: { results: TResult[] }) => TResult[]
): Promise<TResult[]> {
  const all: TResult[] = [];
  let page: string | undefined;
  for (;;) {
    const params = new URLSearchParams(baseParams);
    if (page) params.set("page", page);
    const response = await adminFetch<{ data: { results: TResult[] }[]; has_more: boolean; next_page: string | null }>(
      path,
      params,
      adminKey
    );
    for (const bucket of response.data) all.push(...extract(bucket));
    if (!response.has_more || !response.next_page) break;
    page = response.next_page;
  }
  return all;
}

function rfc3339(date: Date): string {
  return date.toISOString();
}

/** Total USD spend since `since`, no grouping — the dashboard's top-line
 * "spend this month" figure. `amount` is a decimal string in cents. */
export async function fetchAnthropicMonthlyCostUsd(adminKey: string, since: Date): Promise<number> {
  const params = new URLSearchParams({ starting_at: rfc3339(since), bucket_width: "1d" });
  const results = await collectAllResults<AnthropicCostResult>("/cost_report", params, adminKey, (b) => b.results);
  const cents = results.reduce((sum, r) => sum + Number(r.amount), 0);
  return cents / 100;
}

export interface AnthropicModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Token totals grouped by model since `since` — used for "which model has
 * Alfred actually used more" (Claude side of that comparison). */
export async function fetchAnthropicModelUsage(adminKey: string, since: Date): Promise<AnthropicModelUsage[]> {
  const params = new URLSearchParams({ starting_at: rfc3339(since), bucket_width: "1d" });
  params.append("group_by[]", "model");
  const results = await collectAllResults<AnthropicUsageResult>("/usage_report/messages", params, adminKey, (b) => b.results);

  const byModel = new Map<string, AnthropicModelUsage>();
  for (const r of results) {
    if (!r.model) continue;
    const existing = byModel.get(r.model) ?? { model: r.model, inputTokens: 0, outputTokens: 0 };
    existing.inputTokens += r.uncached_input_tokens + r.cache_read_input_tokens;
    existing.outputTokens += r.output_tokens;
    byModel.set(r.model, existing);
  }
  return [...byModel.values()];
}

// OpenAI's organization Usage & Costs API — a separate "Admin Key" from
// Organization Settings, distinct from the regular OPENAI_API_KEY used
// elsewhere in this app (server/llm/openai.ts). Raw fetch, since the `openai`
// SDK package used for Chat completions doesn't cover this surface.
const BASE_URL = "https://api.openai.com/v1/organization";

interface OpenAiUsageResult {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
}

interface OpenAiCostResult {
  amount: { value: number; currency: string };
}

async function adminFetch<T>(path: string, params: URLSearchParams, adminKey: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  if (!res.ok) throw new Error(`OpenAI Admin API ${path} failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function collectAllResults<TResult>(path: string, baseParams: URLSearchParams, adminKey: string): Promise<TResult[]> {
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
    for (const bucket of response.data) all.push(...bucket.results);
    if (!response.has_more || !response.next_page) break;
    page = response.next_page;
  }
  return all;
}

function unixSeconds(date: Date): string {
  return String(Math.floor(date.getTime() / 1000));
}

/** Total USD spend since `since`, no grouping — `amount.value` is already a
 * dollar float (unlike Anthropic's cents-as-decimal-string). */
export async function fetchOpenAiMonthlyCostUsd(adminKey: string, since: Date): Promise<number> {
  const params = new URLSearchParams({ start_time: unixSeconds(since), bucket_width: "1d" });
  const results = await collectAllResults<OpenAiCostResult>("/costs", params, adminKey);
  return results.reduce((sum, r) => sum + r.amount.value, 0);
}

export interface OpenAiModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Token totals grouped by model since `since`. */
export async function fetchOpenAiModelUsage(adminKey: string, since: Date): Promise<OpenAiModelUsage[]> {
  const params = new URLSearchParams({ start_time: unixSeconds(since), bucket_width: "1d" });
  params.append("group_by[]", "model");
  const results = await collectAllResults<OpenAiUsageResult>("/usage/completions", params, adminKey);

  const byModel = new Map<string, OpenAiModelUsage>();
  for (const r of results) {
    if (!r.model) continue;
    const existing = byModel.get(r.model) ?? { model: r.model, inputTokens: 0, outputTokens: 0 };
    existing.inputTokens += r.input_tokens;
    existing.outputTokens += r.output_tokens;
    byModel.set(r.model, existing);
  }
  return [...byModel.values()];
}

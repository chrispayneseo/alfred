import { useEffect, useState } from "react";
import {
  fetchCostDashboard,
  type CostDashboard,
  type FeatureBreakdownEntry,
  type ProviderCostSummary,
} from "../integrations/settings/api";

const PROVIDER_LABEL: Record<ProviderCostSummary["provider"], string> = {
  claude: "Claude (Anthropic)",
  chatgpt: "ChatGPT (OpenAI)",
};

const FEATURE_DISPLAY_KEY: Record<FeatureBreakdownEntry["feature"], string> = {
  chat: "chat",
  capture: "capture",
  gmail_scan_classify: "gmail_scan",
  gmail_scan_reply: "gmail_scan",
  photo_extraction: "photo_extraction",
  nudges: "nudges",
  digest: "digest",
  recurring_detection: "recurring_detection",
  project_grouping: "project_grouping",
  search_console_query: "search_console_query",
};

const FEATURE_LABEL: Record<string, string> = {
  chat: "Chat / Q&A",
  capture: "Capture classification",
  gmail_scan: "Gmail action-item scanning",
  photo_extraction: "Photo-to-calendar",
  nudges: "Nudges",
  digest: "Weekly digest",
  recurring_detection: "Recurring task detection",
  project_grouping: "Project grouping suggestions",
  search_console_query: "Search Console Q&A",
};

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function ProviderBar({ pct, nearCap }: { pct: number; nearCap: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line dark:bg-line-dark">
      <div
        className={`h-full rounded-full transition-all ${nearCap ? "bg-claude" : "bg-ink dark:bg-ink-dark"}`}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

function ProviderCard({ summary, alertThresholdPct }: { summary: ProviderCostSummary; alertThresholdPct: number }) {
  const label = PROVIDER_LABEL[summary.provider];

  if (!summary.configured) {
    return (
      <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
        <p className="text-sm font-medium text-ink dark:text-ink-dark">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint dark:text-ink-faint-dark">
          Not tracked yet — add an Admin API key ({summary.provider === "claude" ? "ANTHROPIC_ADMIN_KEY" : "OPENAI_ADMIN_KEY"}) to
          see spend here.
        </p>
      </div>
    );
  }

  if (summary.error) {
    return (
      <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
        <p className="text-sm font-medium text-ink dark:text-ink-dark">{label}</p>
        <p className="mt-1 text-xs text-claude">{summary.error}</p>
      </div>
    );
  }

  const nearCap = summary.percentOfCap !== undefined && summary.percentOfCap >= alertThresholdPct;

  return (
    <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-ink dark:text-ink-dark">{label}</p>
        <p className="text-xs text-ink-soft dark:text-ink-soft-dark">
          {summary.spendUsd !== undefined ? formatUsd(summary.spendUsd) : "—"}
          {summary.capUsd !== undefined && <> of {formatUsd(summary.capUsd)}</>}
        </p>
      </div>
      {summary.capUsd !== undefined && summary.percentOfCap !== undefined && (
        <div className="mt-2">
          <ProviderBar pct={summary.percentOfCap} nearCap={nearCap} />
          {nearCap && (
            <p className="mt-1.5 text-xs text-claude">{Math.round(summary.percentOfCap)}% of this month's cap.</p>
          )}
        </div>
      )}
      {summary.capUsd === undefined && (
        <p className="mt-1 text-xs text-ink-faint dark:text-ink-faint-dark">No monthly cap set.</p>
      )}
    </div>
  );
}

function ModelComparison({ comparison }: { comparison: CostDashboard["modelComparison"] }) {
  const { claudeTokens, chatgptTokens } = comparison;
  const total = claudeTokens + chatgptTokens;
  if (total === 0) {
    return <p className="text-xs text-ink-faint dark:text-ink-faint-dark">No model calls logged yet this month.</p>;
  }
  const claudePct = Math.round((claudeTokens / total) * 100);
  const leader = claudeTokens === chatgptTokens ? undefined : claudeTokens > chatgptTokens ? "Claude" : "ChatGPT";
  return (
    <p className="text-xs leading-relaxed text-ink-soft dark:text-ink-soft-dark">
      {leader ? (
        <>
          <span className="font-medium text-ink dark:text-ink-dark">{leader}</span> has handled more of Alfred's requests this
          month
        </>
      ) : (
        "Claude and ChatGPT have handled about the same amount this month"
      )}{" "}
      — Claude {claudePct}%, ChatGPT {100 - claudePct}%, by token volume.
    </p>
  );
}

function FeatureBreakdownList({ entries, providers }: { entries: FeatureBreakdownEntry[]; providers: ProviderCostSummary[] }) {
  const merged = new Map<string, { claudeTokens: number; chatgptTokens: number; claudeUsd: number; chatgptUsd: number }>();
  for (const e of entries) {
    const key = FEATURE_DISPLAY_KEY[e.feature];
    const existing = merged.get(key) ?? { claudeTokens: 0, chatgptTokens: 0, claudeUsd: 0, chatgptUsd: 0 };
    existing.claudeTokens += e.claudeTokens;
    existing.chatgptTokens += e.chatgptTokens;
    existing.claudeUsd += e.claudeEstimatedUsd ?? 0;
    existing.chatgptUsd += e.chatgptEstimatedUsd ?? 0;
    merged.set(key, existing);
  }

  const rows = [...merged.entries()]
    .map(([key, v]) => ({ key, ...v, totalTokens: v.claudeTokens + v.chatgptTokens }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  if (rows.length === 0) {
    return <p className="text-xs text-ink-faint dark:text-ink-faint-dark">No model calls logged yet this month.</p>;
  }

  const hasSpend = providers.some((p) => p.spendUsd !== undefined);

  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const usd = row.claudeUsd + row.chatgptUsd;
        return (
          <li key={row.key} className="flex items-center justify-between text-xs">
            <span className="text-ink-soft dark:text-ink-soft-dark">{FEATURE_LABEL[row.key] ?? row.key}</span>
            <span className="text-ink-faint dark:text-ink-faint-dark">{hasSpend ? `~${formatUsd(usd)}` : `${row.totalTokens.toLocaleString()} tokens`}</span>
          </li>
        );
      })}
      {hasSpend && (
        <li className="pt-1 text-[11px] text-ink-faint dark:text-ink-faint-dark">
          Estimated — providers can't attribute spend to Alfred's own features, so this scales each provider's real spend by
          each feature's share of tokens logged.
        </li>
      )}
    </ul>
  );
}

export function ModelCostDashboard() {
  const [dashboard, setDashboard] = useState<CostDashboard>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchCostDashboard()
      .then(setDashboard)
      .catch(() => setError("Couldn't load model cost data right now."));
  }, []);

  if (error) return <p className="text-sm text-claude">{error}</p>;
  if (!dashboard) return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {dashboard.providers.map((p) => (
          <ProviderCard key={p.provider} summary={p} alertThresholdPct={dashboard.alertThresholdPct} />
        ))}
      </div>

      <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
        <p className="mb-2 text-xs font-medium text-ink dark:text-ink-dark">Claude vs ChatGPT</p>
        <ModelComparison comparison={dashboard.modelComparison} />
      </div>

      <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
        <p className="mb-2 text-xs font-medium text-ink dark:text-ink-dark">By feature, this month</p>
        <FeatureBreakdownList entries={dashboard.featureBreakdown} providers={dashboard.providers} />
      </div>
    </div>
  );
}

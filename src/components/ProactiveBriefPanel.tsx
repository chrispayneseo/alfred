import { useCallback, useEffect, useRef, useState } from "react";
import {
  dismissProactiveItem,
  fetchInterruptionDecision,
  fetchLatestMorningBrief,
  fetchMorningBriefStatus,
  fetchProactiveBrief,
  fetchProactiveDeliveryStatus,
  markProactiveSurfaced,
  snoozeProactiveItem,
  type InterruptionDecision,
  type MorningBrief,
  type MorningBriefStatus,
  type ProactiveBand,
  type ProactiveBrief,
  type ProactiveDeliveryStatus,
  type ProactiveItem,
} from "../integrations/proactive/api";

const SOURCE_LABEL: Record<string, string> = {
  tasks: "Task",
  calendar: "Calendar",
  gmail: "Gmail",
};

const BAND_LABEL: Record<ProactiveBand, string> = {
  urgent: "Urgent",
  important: "Important",
  later: "Later",
};

function generatedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "today";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function bandClasses(band: ProactiveBand): string {
  if (band === "urgent") return "border-claude/40 text-claude";
  if (band === "important") return "border-ink-faint/40 text-ink dark:border-ink-faint-dark/40 dark:text-ink-dark";
  return "border-line text-ink-faint dark:border-line-dark dark:text-ink-faint-dark";
}

function interruptionLabel(decision: InterruptionDecision | undefined): string {
  if (!decision) return "Checking interruption policy…";
  if (decision.decision === "surface_candidate") return "Worth your attention now";
  if (decision.decision === "hold_quiet_hours") return "Held during quiet hours";
  if (decision.decision === "hold_cooldown") {
    return `Quiet for another ${decision.cooldown_remaining_minutes} min`;
  }
  return "No interruption needed";
}

export function ProactiveBriefPanel() {
  const [brief, setBrief] = useState<ProactiveBrief>();
  const [morning, setMorning] = useState<MorningBrief | null>();
  const [morningStatus, setMorningStatus] = useState<MorningBriefStatus>();
  const [decision, setDecision] = useState<InterruptionDecision>();
  const [delivery, setDelivery] = useState<ProactiveDeliveryStatus | null>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const surfacedRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [nextBrief, nextMorning, nextStatus, nextDecision, nextDelivery] = await Promise.all([
        fetchProactiveBrief(8),
        fetchLatestMorningBrief(),
        fetchMorningBriefStatus(),
        fetchInterruptionDecision(),
        fetchProactiveDeliveryStatus().catch(() => null),
      ]);
      setBrief(nextBrief);
      setMorning(nextMorning);
      setMorningStatus(nextStatus);
      setDecision(nextDecision);
      setDelivery(nextDelivery);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Alfred's brief.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (decision?.decision !== "surface_candidate" || !decision.item) return;
    if (surfacedRef.current === decision.item.id) return;
    surfacedRef.current = decision.item.id;
    void markProactiveSurfaced(decision.item.id).catch(() => {
      surfacedRef.current = undefined;
    });
  }, [decision]);

  async function dismiss(item: ProactiveItem) {
    setBusy(item.id);
    try {
      await dismissProactiveItem(item.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not dismiss this item.");
    } finally {
      setBusy(undefined);
    }
  }

  async function snooze(item: ProactiveItem) {
    setBusy(item.id);
    try {
      await snoozeProactiveItem(item.id, 180);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not snooze this item.");
    } finally {
      setBusy(undefined);
    }
  }

  if (loading && !brief) {
    return (
      <section className="mb-6 rounded-2xl border border-line p-4 dark:border-line-dark">
        <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Alfred is preparing your brief…</p>
      </section>
    );
  }

  if (error && !brief) {
    return (
      <section className="mb-6 rounded-2xl border border-line p-4 dark:border-line-dark">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Alfred brief</h2>
            <p role="alert" className="mt-2 text-sm text-ink-soft dark:text-ink-soft-dark">{error}</p>
          </div>
          <button type="button" onClick={() => void refresh()} className="text-xs underline text-ink-soft dark:text-ink-soft-dark">Retry</button>
        </div>
      </section>
    );
  }

  if (!brief) return null;

  const todaysMorning = morning && morningStatus && morning.brief_date === morningStatus.local_date ? morning : null;
  const total = brief.counts.total;

  return (
    <section className="mb-6 rounded-2xl border border-line p-4 dark:border-line-dark">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Alfred brief</h2>
            <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-faint dark:border-line-dark dark:text-ink-faint-dark">
              Local
            </span>
          </div>
          <p className="mt-2 text-base font-medium text-ink dark:text-ink-dark">{brief.headline}</p>
          <p className="mt-1 text-xs text-ink-faint dark:text-ink-faint-dark">
            {interruptionLabel(decision)}
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="text-xs underline text-ink-soft disabled:opacity-50 dark:text-ink-soft-dark">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
        {brief.counts.urgent > 0 && <span className="rounded-full border border-claude/40 px-2 py-1 text-claude">{brief.counts.urgent} urgent</span>}
        {brief.counts.important > 0 && <span className="rounded-full border border-ink-faint/40 px-2 py-1 text-ink dark:border-ink-faint-dark/40 dark:text-ink-dark">{brief.counts.important} important</span>}
        {brief.counts.later > 0 && <span className="rounded-full border border-line px-2 py-1 text-ink-faint dark:border-line-dark dark:text-ink-faint-dark">{brief.counts.later} later</span>}
        {total === 0 && <span className="text-ink-faint dark:text-ink-faint-dark">Nothing needs attention right now.</span>}
      </div>

      {todaysMorning ? (
        <div className="mt-4 rounded-xl border border-line px-3 py-2.5 dark:border-line-dark">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-soft dark:text-ink-soft-dark">Morning brief</p>
            <p className="text-[11px] text-ink-faint dark:text-ink-faint-dark">Prepared {generatedLabel(todaysMorning.generated_at)}</p>
          </div>
          <p className="mt-1 text-sm text-ink dark:text-ink-dark">{todaysMorning.headline}</p>
        </div>
      ) : morningStatus ? (
        <p className="mt-4 text-xs text-ink-faint dark:text-ink-faint-dark">
          Daily brief scheduled for {morningStatus.scheduled_time}.
        </p>
      ) : null}

      {brief.items.length > 0 && (
        <ul className="mt-4 divide-y divide-line dark:divide-line-dark">
          {brief.items.map((item) => (
            <li key={item.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${bandClasses(item.band)}`}>{BAND_LABEL[item.band]}</span>
                    <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-faint dark:border-line-dark dark:text-ink-faint-dark">
                      {SOURCE_LABEL[item.source] ?? item.source}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-ink dark:text-ink-dark">{item.title}</p>
                  <p className="mt-0.5 text-xs text-ink-soft dark:text-ink-soft-dark">{item.summary}</p>
                </div>
                <div className="flex shrink-0 gap-2 text-[11px]">
                  <button type="button" disabled={busy === item.id} onClick={() => void snooze(item)} className="underline text-ink-soft disabled:opacity-40 dark:text-ink-soft-dark">Snooze 3h</button>
                  <button type="button" disabled={busy === item.id} onClick={() => void dismiss(item)} className="underline text-ink-soft disabled:opacity-40 dark:text-ink-soft-dark">Dismiss</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert" className="mt-3 text-xs text-claude">{error}</p>}
      <p className="mt-4 text-[10px] text-ink-faint dark:text-ink-faint-dark">
        {delivery?.enabled && delivery.configured
          ? "Observed locally · generic phone nudges policy-gated · item content stays on the Dell"
          : "Observed locally · phone nudges off"}
      </p>
    </section>
  );
}

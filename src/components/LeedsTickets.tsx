import { useEffect, useState } from "react";
import {
  actionTicketWindow,
  checkLeedsTickets,
  dismissReviewWindow,
  type LeedsTicketsState,
  type TicketWindow,
} from "../integrations/leedsTickets/api";

function formatCountdown(targetIso: string, nowMs: number): string {
  const diffMs = new Date(targetIso).getTime() - nowMs;
  if (diffMs <= 0) return "now";
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

type PhaseDisplay =
  | { state: "pending"; label: string; target: string }
  | { state: "open"; label: string }
  | { state: "open_ballot"; label: string; target: string }
  | { state: "closed_ballot"; label: string };

function phaseDisplay(w: TicketWindow, nowMs: number): PhaseDisplay {
  const opensMs = new Date(w.opensAt).getTime();
  if (w.phaseKind === "direct_sale") {
    if (nowMs < opensMs) return { state: "pending", label: "tickets in", target: w.opensAt };
    return { state: "open", label: "On sale now" };
  }
  if (nowMs < opensMs) return { state: "pending", label: "ballot opens in", target: w.opensAt };
  if (w.closesAt && nowMs < new Date(w.closesAt).getTime()) {
    return { state: "open_ballot", label: "ballot closes in", target: w.closesAt };
  }
  return { state: "closed_ballot", label: "Ballot closed — awaiting result" };
}

function targetMs(w: TicketWindow): number {
  return new Date(w.closesAt ?? w.opensAt).getTime();
}

/** One row per fixture, not per phase — a fixture's several sale/ballot
 * phases (direct sale, ballot application, ticket exchange, ...) collapse
 * to whichever is earliest and not yet a fully-resolved closed ballot. A
 * ballot phase whose deadline has passed is skipped in favor of the next
 * phase automatically; a currently-open direct-sale phase is never skipped
 * this way (it has no deadline of its own to pass) — it stays the
 * displayed phase until manually marked done, same as before. */
function currentPhasePerFixture(windows: TicketWindow[], nowMs: number): TicketWindow[] {
  const byFixture = new Map<string, TicketWindow[]>();
  for (const w of windows) {
    const key = `${w.opponent}|${w.homeAway}`;
    const list = byFixture.get(key);
    if (list) list.push(w);
    else byFixture.set(key, [w]);
  }

  const current: TicketWindow[] = [];
  for (const phases of byFixture.values()) {
    const sorted = [...phases].sort((a, b) => targetMs(a) - targetMs(b));
    const next = sorted.find((w) => phaseDisplay(w, nowMs).state !== "closed_ballot") ?? sorted[sorted.length - 1];
    current.push(next);
  }
  return current.sort((a, b) => targetMs(a) - targetMs(b));
}

/** Tile content for the "Tickets" section (desktop grid tile / mobile
 * section — the heading with the club-colors badge lives in the parent,
 * since as a tile this needs to stay present with an empty state rather
 * than vanishing, matching how Nudges/Evie/Flagged behave as tiles). Ticks
 * locally every minute for the live countdown rather than re-fetching,
 * since the underlying data only meaningfully changes on a new scan
 * (already re-checked whenever this mounts, i.e. every Today open). */
export function LeedsTickets() {
  const [data, setData] = useState<LeedsTicketsState>();
  const [busyId, setBusyId] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    checkLeedsTickets()
      .then(setData)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  async function handleAction(id: string) {
    setBusyId(id);
    try {
      await actionTicketWindow(id);
      setData((prev) => (prev ? { ...prev, windows: prev.windows.filter((w) => w.id !== id) } : prev));
    } finally {
      setBusyId(undefined);
    }
  }

  async function handleDismissReview(id: string) {
    setBusyId(id);
    try {
      await dismissReviewWindow(id);
      setData((prev) => (prev ? { ...prev, review: prev.review.filter((r) => r.id !== id) } : prev));
    } finally {
      setBusyId(undefined);
    }
  }

  if (!data) return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Checking…</p>;

  const fixtures = currentPhasePerFixture(data.windows, now);

  if (fixtures.length === 0 && data.review.length === 0) {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing on sale right now.</p>;
  }

  return (
    <div>
      {fixtures.length > 0 && (
        <ul className="space-y-2">
          {fixtures.map((w) => {
            const display = phaseDisplay(w, now);
            const isLive = display.state === "open" || display.state === "closed_ballot";
            return (
              <li key={w.id} className="rounded-xl border border-line px-3.5 py-2.5 dark:border-line-dark">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink dark:text-ink-dark">
                      {w.opponent} ({w.homeAway})
                    </p>
                    <p className="truncate text-xs text-ink-faint dark:text-ink-faint-dark">{w.phaseLabel}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`text-xs font-medium ${isLive ? "text-claude" : "text-ink-soft dark:text-ink-soft-dark"}`}>
                      {display.state === "pending" || display.state === "open_ballot"
                        ? `${display.label} ${formatCountdown(display.target, now)}`
                        : display.label}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleAction(w.id)}
                  disabled={busyId === w.id}
                  className="mt-1.5 text-[11px] text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                >
                  Mark done
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {data.review.length > 0 && (
        <div className={fixtures.length > 0 ? "mt-4" : undefined}>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
            Needs review
          </p>
          <ul className="space-y-2">
            {data.review.map((r) => (
              <li key={r.id} className="rounded-xl border border-line px-3.5 py-2.5 dark:border-line-dark">
                <p className="text-sm text-ink dark:text-ink-dark">
                  {r.opponent} ({r.homeAway}) — {r.phaseLabel}
                </p>
                <p className="mt-0.5 text-xs text-ink-faint dark:text-ink-faint-dark">{r.note}</p>
                <button
                  onClick={() => handleDismissReview(r.id)}
                  disabled={busyId === r.id}
                  className="mt-1.5 text-[11px] text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

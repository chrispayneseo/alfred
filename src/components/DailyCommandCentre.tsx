import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchDailyOperations, type DailyOperationsToday } from "../integrations/local/dailyOperations";

function Stat({ label, value, attention = false }: { label: string; value: number; attention?: boolean }) {
  return <div className="rounded-xl border border-line px-3 py-2 dark:border-line-dark">
    <p className={`text-lg font-semibold ${attention && value > 0 ? "text-claude" : "text-ink dark:text-ink-dark"}`}>{value}</p>
    <p className="text-[11px] text-ink-faint dark:text-ink-faint-dark">{label}</p>
  </div>;
}

export function DailyCommandCentre() {
  const [data, setData] = useState<DailyOperationsToday>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setData(await fetchDailyOperations());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Alfred's daily control plane.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <section className="mb-8 rounded-2xl border border-line p-4 dark:border-line-dark">
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Alfred command centre</h2>
        <p className="mt-1 text-xs text-ink-soft dark:text-ink-soft-dark">Capture, approvals and agent work — all through the guarded Core path.</p>
      </div>
      <button type="button" onClick={() => void refresh()} className="text-xs underline text-ink-soft dark:text-ink-soft-dark">Refresh</button>
    </div>

    {error && <p role="alert" className="text-xs text-claude">{error}</p>}
    {!data && !error && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading Alfred…</p>}
    {data && <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Needs you" value={data.counts.needs_you} attention />
        <Stat label="Active goals" value={data.counts.active_goals} />
        <Stat label="Done today" value={data.counts.completed_work_today} />
        <Stat label="Overdue" value={data.counts.overdue} attention />
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-xs">
        <Link to="/inbox" className="underline text-ink-soft dark:text-ink-soft-dark">Open Alfred Inbox</Link>
        <Link to="/search" className="underline text-ink-soft dark:text-ink-soft-dark">Search Alfred</Link>
        <Link to="/chat" className="underline text-ink-soft dark:text-ink-soft-dark">Ask Alfred</Link>
      </div>

      {data.needs_you.length === 0 ? (
        <p className="mt-3 text-sm text-ink-faint dark:text-ink-faint-dark">Nothing needs your attention.</p>
      ) : (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium text-ink-soft dark:text-ink-soft-dark">Needs you</h3>
            <div className="flex gap-3">
              <Link to="/inbox" className="text-xs underline text-ink-soft dark:text-ink-soft-dark">View all</Link>
              {data.counts.pending_intake > 0 && <Link to="/capture" className="text-xs underline text-ink-soft dark:text-ink-soft-dark">Review capture</Link>}
            </div>
          </div>
          <ul className="space-y-2">
            {data.needs_you.slice(0, 6).map((item, index) => <li key={`${item.type}:${item.id ?? index}`} className="rounded-xl bg-paper-raised px-3 py-2 dark:bg-paper-raised-dark">
              <p className="text-sm text-ink dark:text-ink-dark">{item.title ?? item.action ?? "Alfred needs attention"}</p>
              <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
                {item.reason.replaceAll("_", " ")}{item.due ? ` · ${item.due}` : ""}{item.risk_level ? ` · ${item.risk_level}` : ""}
              </p>
            </li>)}
          </ul>
        </div>
      )}

      <p className="mt-3 text-[11px] text-ink-faint dark:text-ink-faint-dark">
        {data.counts.pending_intake} intake · {data.counts.open_local_items} local items · {data.counts.waiting_agent_approvals} agent approvals · {data.counts.attention_items_today} execution alerts
      </p>
    </>}
  </section>;
}

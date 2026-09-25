import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchAgentInbox, type AgentInbox, type AgentInboxItem } from "../integrations/local/personalAgent";
import { CONTENT_MAX_WIDTH, CONTENT_PADDING_X } from "../lib/layout";

function InboxSection({ title, items, empty }: { title: string; items: AgentInboxItem[]; empty: string }) {
  return (
    <section className="mt-7">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">{title}</h2>
        <span className="text-xs text-ink-faint dark:text-ink-faint-dark">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-2xl border border-line px-4 py-4 text-sm text-ink-faint dark:border-line-dark dark:text-ink-faint-dark">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, index) => (
            <li key={`${item.type}:${item.id ?? index}`} className="rounded-2xl border border-line bg-paper-raised px-4 py-3 dark:border-line-dark dark:bg-paper-raised-dark">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink dark:text-ink-dark">{item.title}</p>
                  <p className="mt-1 text-xs text-ink-faint dark:text-ink-faint-dark">
                    {item.reason}{item.due ? ` · ${item.due}` : ""}{item.risk_level ? ` · ${item.risk_level.replaceAll("_", " ")}` : ""}
                  </p>
                </div>
                {item.route && item.route !== "/inbox" && (
                  <Link to={item.route} className="shrink-0 text-xs underline text-ink-soft dark:text-ink-soft-dark">Open</Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AgentInboxScreen() {
  const [data, setData] = useState<AgentInbox>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setData(await fetchAgentInbox());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Alfred Inbox.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <main className={`mx-auto ${CONTENT_MAX_WIDTH} ${CONTENT_PADDING_X} pb-28 pt-[max(2rem,env(safe-area-inset-top))]`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium tracking-tight text-ink dark:text-ink-dark">Alfred Inbox</h1>
          <p className="mt-1 text-sm text-ink-soft dark:text-ink-soft-dark">One place for decisions, work in progress and verified completions.</p>
        </div>
        <button type="button" onClick={() => void refresh()} className="text-xs underline text-ink-soft dark:text-ink-soft-dark">Refresh</button>
      </div>

      {loading && <p className="mt-6 text-sm text-ink-faint dark:text-ink-faint-dark">Loading Alfred…</p>}
      {error && <p role="alert" className="mt-6 rounded-2xl border border-line px-4 py-3 text-sm text-claude dark:border-line-dark">{error}</p>}

      {data && (
        <>
          <div className="mt-6 grid grid-cols-3 gap-2">
            {[
              ["Needs you", data.counts.needs_you],
              ["Working", data.counts.working],
              ["Done", data.counts.done],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-line px-3 py-2 dark:border-line-dark">
                <p className="text-lg font-semibold text-ink dark:text-ink-dark">{value}</p>
                <p className="text-[11px] text-ink-faint dark:text-ink-faint-dark">{label}</p>
              </div>
            ))}
          </div>
          <InboxSection title="Needs you" items={data.needs_you} empty="Nothing needs your decision right now." />
          <InboxSection title="Working" items={data.working} empty="Alfred has no active agent work." />
          <InboxSection title="Done" items={data.done} empty="No verified completions yet today." />
        </>
      )}
    </main>
  );
}

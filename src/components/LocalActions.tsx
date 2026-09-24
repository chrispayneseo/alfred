import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { completeLocalItem, listFiledWhatsApp, type FiledInboxItem } from "../integrations/local/api";

export function LocalActions() {
  const [items, setItems] = useState<FiledInboxItem[]>([]);
  const [connected, setConnected] = useState<boolean>();
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const result = await listFiledWhatsApp();
      setItems(result.items.filter((item) => item.kind === "task" || item.kind === "reminder"));
      setNotificationsEnabled(result.notifications_enabled);
      setConnected(true);
      setError(undefined);
    } catch (cause) {
      setConnected(false);
      setError(cause instanceof Error ? cause.message : "Could not load local tasks.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function toggle(item: FiledInboxItem) {
    setBusy(item.source_id);
    try {
      await completeLocalItem(item.source_id, !item.completed_at);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the item.");
    } finally {
      setBusy(undefined);
    }
  }

  const open = items.filter((item) => !item.completed_at)
    .sort((a, b) => (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31"));
  const done = items.filter((item) => item.completed_at);
  const londonParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (name: string) => londonParts.find((entry) => entry.type === name)?.value ?? "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;

  return <section className="mb-8 rounded-2xl border border-line p-4 dark:border-line-dark">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Alfred local tasks & reminders</h2>
      <Link to="/capture" className="text-xs underline text-ink-soft dark:text-ink-soft-dark">Add or review</Link>
    </div>
    {connected === undefined && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading local items…</p>}
    {error && <p role="alert" className="mb-2 text-xs text-claude">{error}</p>}
    {connected === true && open.length === 0 && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing open locally.</p>}
    {open.length > 0 && <ul className="space-y-3">{open.map((item) => <li key={item.source_id} className="flex items-start gap-3">
      <button type="button" onClick={() => void toggle(item)} disabled={busy === item.source_id}
        aria-label={`Mark ${item.title} done`} className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-line disabled:opacity-40 dark:border-line-dark" />
      <div className="min-w-0">
        <p className="text-sm text-ink dark:text-ink-dark">{item.title}</p>
        <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
          {item.kind === "reminder" ? "Reminder" : "Task"}{item.due ? ` · ${item.due}${item.due < today ? " · overdue" : ""}` : ""}
          {item.kind === "reminder" && item.notified_at ? " · alert sent" : ""}
        </p>
        {item.detail && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-soft dark:text-ink-soft-dark">{item.detail}</p>}
      </div>
    </li>)}</ul>}
    {done.length > 0 && <details className="mt-4 text-xs text-ink-soft dark:text-ink-soft-dark"><summary>Completed ({done.length})</summary>
      <ul className="mt-2 space-y-2">{done.map((item) => <li key={item.source_id} className="flex items-center gap-2">
        <button type="button" onClick={() => void toggle(item)} disabled={busy === item.source_id}
          aria-label={`Reopen ${item.title}`} className="h-5 w-5 shrink-0 rounded-full bg-ink text-xs text-paper disabled:opacity-40 dark:bg-ink-dark dark:text-paper-dark">✓</button>
        <span>{item.title}</span>
      </li>)}</ul>
    </details>}
    {connected && !notificationsEnabled && open.some((item) => item.kind === "reminder") &&
      <p className="mt-3 text-xs text-ink-faint dark:text-ink-faint-dark">Phone alerts are not connected yet; check Today for due reminders.</p>}
  </section>;
}

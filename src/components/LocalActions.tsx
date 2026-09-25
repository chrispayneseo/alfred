import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AgentActivity } from "./AgentActivity";
import { DailyCommandCentre } from "./DailyCommandCentre";
import { ProactiveBriefPanel } from "./ProactiveBriefPanel";
import { completeLocalItem, editLocalItem, forgetLocalItem, listFiledWhatsApp, type FiledInboxItem } from "../integrations/local/api";

export function LocalActions() {
  const [items, setItems] = useState<FiledInboxItem[]>([]);
  const [connected, setConnected] = useState<boolean>();
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [correction, setCorrection] = useState({ title: "", due: "", detail: "" });
  const selectedId = new URLSearchParams(window.location.search).get("localItem");

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

  useEffect(() => {
    if (selectedId && items.some((item) => item.source_id === selectedId)) {
      document.getElementById(`local-${selectedId}`)?.scrollIntoView({ block: "center" });
    }
  }, [items, selectedId]);

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

  async function saveCorrection(item: FiledInboxItem) {
    setBusy(item.source_id);
    try {
      await editLocalItem({ source_id: item.source_id, title: correction.title.trim(), due: correction.due || null, detail: correction.detail });
      setEditing(undefined);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not correct the item."); }
    finally { setBusy(undefined); }
  }

  async function forget(item: FiledInboxItem) {
    if (!window.confirm(`Forget this ${item.kind}?`)) return;
    setBusy(item.source_id);
    try { await forgetLocalItem(item.source_id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not forget the item."); }
    finally { setBusy(undefined); }
  }

  function controls(item: FiledInboxItem) {
    return editing === item.source_id ? <div className="mt-2 space-y-2">
      <input aria-label="Correct title" value={correction.title} onChange={(event) => setCorrection((old) => ({ ...old, title: event.target.value }))} maxLength={200} className="w-full rounded border border-line bg-transparent p-1 text-xs" />
      <input aria-label="Correct due date" type="date" value={correction.due} onChange={(event) => setCorrection((old) => ({ ...old, due: event.target.value }))} className="rounded border border-line bg-transparent p-1 text-xs" />
      <textarea aria-label="Correct details" value={correction.detail} onChange={(event) => setCorrection((old) => ({ ...old, detail: event.target.value }))} maxLength={1000} className="w-full rounded border border-line bg-transparent p-1 text-xs" />
      <button type="button" disabled={busy === item.source_id || !correction.title.trim()} onClick={() => void saveCorrection(item)} className="mr-3 text-xs underline">Save correction</button>
      <button type="button" onClick={() => setEditing(undefined)} className="text-xs underline">Cancel</button>
    </div> : <div className="mt-1 flex gap-3 text-xs">
      <button type="button" onClick={() => { setEditing(item.source_id); setCorrection({ title: item.title, due: item.due ?? "", detail: item.detail ?? "" }); }} className="underline">Correct</button>
      <button type="button" disabled={busy === item.source_id} onClick={() => void forget(item)} className="underline">Forget</button>
    </div>;
  }

  const open = items.filter((item) => !item.completed_at)
    .sort((a, b) => (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31"));
  const done = items.filter((item) => item.completed_at);
  const londonParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (name: string) => londonParts.find((entry) => entry.type === name)?.value ?? "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;

  return <>
    <DailyCommandCentre />
    <AgentActivity />
    <ProactiveBriefPanel />
    <section className="mb-8 rounded-2xl border border-line p-4 dark:border-line-dark">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Alfred local tasks & reminders</h2>
        <Link to="/capture" className="text-xs underline text-ink-soft dark:text-ink-soft-dark">Add or review</Link>
      </div>
      {connected === undefined && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading local items…</p>}
      {error && <p role="alert" className="mb-2 text-xs text-claude">{error}</p>}
      {connected === true && open.length === 0 && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing open locally.</p>}
      {open.length > 0 && <ul className="space-y-3">{open.map((item) => <li id={`local-${item.source_id}`} key={item.source_id} className={`flex scroll-mt-4 items-start gap-3 ${selectedId === item.source_id ? "rounded-xl border border-line p-2 dark:border-line-dark" : ""}`}>
        <button type="button" onClick={() => void toggle(item)} disabled={busy === item.source_id}
          aria-label={`Mark ${item.title} done`} className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-line disabled:opacity-40 dark:border-line-dark" />
        <div className="min-w-0">
          <p className="text-sm text-ink dark:text-ink-dark">{item.title}</p>
          <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
            {item.kind === "reminder" ? "Reminder" : "Task"}{item.due ? ` · ${item.due}${item.due < today ? " · overdue" : ""}` : ""}
            {item.kind === "reminder" && item.notified_at ? " · alert sent" : ""}
          </p>
          {item.detail && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-soft dark:text-ink-soft-dark">{item.detail}</p>}
          {controls(item)}
        </div>
      </li>)}</ul>}
      {done.length > 0 && <details open={done.some((item) => item.source_id === selectedId) ? true : undefined} className="mt-4 text-xs text-ink-soft dark:text-ink-soft-dark"><summary>Completed ({done.length})</summary>
        <ul className="mt-2 space-y-2">{done.map((item) => <li id={`local-${item.source_id}`} key={item.source_id} className="flex items-center gap-2">
          <button type="button" onClick={() => void toggle(item)} disabled={busy === item.source_id}
            aria-label={`Reopen ${item.title}`} className="h-5 w-5 shrink-0 rounded-full bg-ink text-xs text-paper disabled:opacity-40 dark:bg-ink-dark dark:text-paper-dark">✓</button>
          <span>{item.title}{controls(item)}</span>
        </li>)}</ul>
      </details>}
      {connected && !notificationsEnabled && open.some((item) => item.kind === "reminder") &&
        <p className="mt-3 text-xs text-ink-faint dark:text-ink-faint-dark">Phone alerts are not connected yet; check Today for due reminders.</p>}
    </section>
  </>;
}
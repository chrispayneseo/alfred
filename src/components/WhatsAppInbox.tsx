import { useCallback, useEffect, useState } from "react";
import {
  discardWhatsApp, fileWhatsApp, listFiledWhatsApp, listWhatsAppInbox,
  triageWhatsApp, type FiledInboxItem, type InboxKind, type WhatsAppInboxItem,
} from "../integrations/local/api";

type Filing = { kind: InboxKind; title: string; due: string; detail: string };

function defaultFiling(item: WhatsAppInboxItem): Filing {
  return {
    kind: item.suggested_kind ?? "clarify",
    title: item.suggested_title ?? item.body.slice(0, 200),
    due: item.suggested_due ?? "",
    detail: item.suggested_detail ?? "",
  };
}

export function WhatsAppInbox() {
  const [items, setItems] = useState<WhatsAppInboxItem[]>([]);
  const [filed, setFiled] = useState<FiledInboxItem[]>([]);
  const [edits, setEdits] = useState<Record<string, Filing>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [incoming, saved] = await Promise.all([listWhatsAppInbox(), listFiledWhatsApp()]);
      setItems(incoming);
      setFiled(saved);
      setEdits((current) => {
        const next = { ...current };
        for (const item of incoming) if (!next[item.id]) next[item.id] = defaultFiling(item);
        return next;
      });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't load the local inbox.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  function change(id: string, patch: Partial<Filing>) {
    setEdits((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  async function analyse(id: string) {
    setBusy(id);
    setError(undefined);
    try {
      await triageWhatsApp(id);
      const incoming = await listWhatsAppInbox();
      setItems(incoming);
      const item = incoming.find((entry) => entry.id === id);
      if (item) setEdits((current) => ({ ...current, [id]: defaultFiling(item) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Local analysis failed.");
    } finally {
      setBusy(undefined);
    }
  }

  async function save(item: WhatsAppInboxItem) {
    const edit = edits[item.id] ?? defaultFiling(item);
    if (edit.kind === "clarify") return;
    setBusy(item.id);
    setError(undefined);
    try {
      await fileWhatsApp(item.id, {
        kind: edit.kind, title: edit.title.trim(), due: edit.due || null, detail: edit.detail.trim(),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the item.");
    } finally {
      setBusy(undefined);
    }
  }

  async function discard(item: WhatsAppInboxItem) {
    if (!window.confirm("Permanently discard this forwarded message?")) return;
    setBusy(item.id);
    setError(undefined);
    try {
      await discardWhatsApp(item.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not discard the message.");
    } finally {
      setBusy(undefined);
    }
  }

  const pending = items.filter((item) => item.state !== "filed");
  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink dark:text-ink-dark">WhatsApp inbox</h2>
          <p className="mt-1 text-xs text-ink-soft dark:text-ink-soft-dark">
            Alfred analyses forwards on the Dell. Nothing is filed until you approve it.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} className="text-xs underline text-ink-soft dark:text-ink-soft-dark">Refresh</button>
      </div>
      {error && <p role="alert" className="text-sm text-claude">{error}</p>}
      {loading && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>}
      {!loading && pending.length === 0 && <p className="rounded-2xl border border-line p-4 text-sm text-ink-soft dark:border-line-dark dark:text-ink-soft-dark">No forwarded messages waiting for review.</p>}
      {pending.map((item) => {
        const edit = edits[item.id] ?? defaultFiling(item);
        return (
          <article key={item.id} className="space-y-3 rounded-2xl border border-line p-4 dark:border-line-dark">
            <p className="whitespace-pre-wrap break-words text-sm text-ink dark:text-ink-dark">{item.body}</p>
            <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
              {item.state === "new" ? "Waiting for local analysis" : "Alfred's suggestion — review and edit"}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-ink-soft dark:text-ink-soft-dark">Type
                <select value={edit.kind} onChange={(event) => change(item.id, { kind: event.target.value as InboxKind })}
                  className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark">
                  <option value="clarify">Needs clarification</option>
                  <option value="note">Remember</option>
                  <option value="task">Task</option>
                  <option value="reminder">Reminder draft</option>
                </select>
              </label>
              <label className="text-xs text-ink-soft dark:text-ink-soft-dark">Date {edit.kind === "reminder" ? "(required)" : "(optional)"}
                <input type="date" value={edit.due} onChange={(event) => change(item.id, { due: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark" />
              </label>
            </div>
            <label className="block text-xs text-ink-soft dark:text-ink-soft-dark">Title
              <input value={edit.title} maxLength={200} onChange={(event) => change(item.id, { title: event.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark" />
            </label>
            <label className="block text-xs text-ink-soft dark:text-ink-soft-dark">Details
              <textarea value={edit.detail} maxLength={1000} onChange={(event) => change(item.id, { detail: event.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark" />
            </label>
            {edit.kind === "reminder" && <p className="text-xs text-ink-faint dark:text-ink-faint-dark">This saves a dated reminder draft; notifications are not enabled yet.</p>}
            <div className="flex flex-wrap gap-3 text-xs">
              <button type="button" onClick={() => void save(item)} disabled={busy === item.id || edit.kind === "clarify" || !edit.title.trim() || (edit.kind === "reminder" && !edit.due)}
                className="rounded-full bg-ink px-4 py-2 font-medium text-paper disabled:opacity-40 dark:bg-ink-dark dark:text-paper-dark">Approve and save</button>
              <button type="button" onClick={() => void analyse(item.id)} disabled={busy === item.id} className="underline text-ink-soft disabled:opacity-40 dark:text-ink-soft-dark">Analyse again</button>
              <button type="button" onClick={() => void discard(item)} disabled={busy === item.id} className="underline text-claude disabled:opacity-40">Discard</button>
            </div>
          </article>
        );
      })}
      {filed.length > 0 && <section className="space-y-2 pt-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Approved items</h3>
        {filed.slice(0, 10).map((item) => <p key={item.source_id} className="text-sm text-ink-soft dark:text-ink-soft-dark">
          {item.title} <span className="text-xs text-ink-faint dark:text-ink-faint-dark">· {item.kind}{item.due ? ` · ${item.due}` : ""}</span>
        </p>)}
      </section>}
    </section>
  );
}

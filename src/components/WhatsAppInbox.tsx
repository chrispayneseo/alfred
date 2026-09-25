import { useCallback, useEffect, useState } from "react";
import {
  createLocalItem, discardWhatsApp, fileWhatsApp, listFiledWhatsApp, listWhatsAppInbox,
  triageWhatsApp, type FiledInboxItem, type InboxKind, type WhatsAppInboxItem,
} from "../integrations/local/api";
import {
  fetchDailyOperations, proposeWhatsAppForCore, resolveWhatsAppCore, reviewWhatsAppForCore,
  type DailyIntakeItem,
} from "../integrations/local/dailyOperations";

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
  const [core, setCore] = useState<Record<string, DailyIntakeItem>>({});
  const [edits, setEdits] = useState<Record<string, Filing>>({});
  const [busy, setBusy] = useState<string>();
  const [manual, setManual] = useState<Filing>({ kind: "task", title: "", due: "", detail: "" });
  const [manualId, setManualId] = useState(() => `manual:${crypto.randomUUID()}`);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [incoming, saved, daily] = await Promise.all([
        listWhatsAppInbox(),
        listFiledWhatsApp(),
        fetchDailyOperations().catch(() => undefined),
      ]);
      setItems(incoming);
      setFiled(saved.items);
      setNotificationsEnabled(saved.notifications_enabled);
      setCore(Object.fromEntries((daily?.pending_intake ?? []).map((item) => [item.id, item])));
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
    if (edit.kind === "clarify" || core[item.id]?.approval_id) return;
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

  async function dispatch(item: WhatsAppInboxItem) {
    const edit = edits[item.id] ?? defaultFiling(item);
    if (edit.kind !== "task" && edit.kind !== "reminder") return;
    setBusy(`core:${item.id}`);
    setError(undefined);
    try {
      await reviewWhatsAppForCore(item.id, {
        kind: edit.kind,
        title: edit.title.trim(),
        due: edit.due || null,
        detail: edit.detail.trim(),
      });
      await proposeWhatsAppForCore(item.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the Core approval.");
    } finally {
      setBusy(undefined);
    }
  }

  async function resolveCore(item: WhatsAppInboxItem, approved: boolean) {
    setBusy(`core:${item.id}`);
    setError(undefined);
    try {
      await resolveWhatsAppCore(item.id, approved);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not resolve the Core approval.");
    } finally {
      setBusy(undefined);
    }
  }

  async function discard(item: WhatsAppInboxItem) {
    if (core[item.id]?.approval_id) {
      setError("Resolve the linked Core approval before discarding this capture.");
      return;
    }
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

  async function saveManual() {
    if (!manual.title.trim() || (manual.kind === "reminder" && !manual.due)) return;
    setBusy("manual");
    setError(undefined);
    try {
      await createLocalItem({
        source_id: manualId, kind: manual.kind as "note" | "task" | "reminder",
        title: manual.title.trim(), due: manual.due || null, detail: manual.detail.trim(),
      });
      setManual({ kind: "task", title: "", due: "", detail: "" });
      setManualId(`manual:${crypto.randomUUID()}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the item.");
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
            Alfred analyses forwards on the Dell. Raw forwarded text is never a Core instruction; you review the action first.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} className="text-xs underline text-ink-soft dark:text-ink-soft-dark">Refresh</button>
      </div>
      {error && <p role="alert" className="text-sm text-claude">{error}</p>}
      <div className="space-y-3 rounded-2xl border border-line p-4 dark:border-line-dark">
        <h3 className="text-sm font-semibold text-ink dark:text-ink-dark">Add something now</h3>
        <p className="text-xs text-ink-soft dark:text-ink-soft-dark">Save a local task, reminder or memory without waiting for WhatsApp.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-ink-soft dark:text-ink-soft-dark">Type
            <select value={manual.kind} onChange={(event) => setManual((current) => ({ ...current, kind: event.target.value as InboxKind }))}
              className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark">
              <option value="task">Task</option><option value="reminder">Reminder</option><option value="note">Remember</option>
            </select>
          </label>
          <label className="text-xs text-ink-soft dark:text-ink-soft-dark">Date {manual.kind === "reminder" ? "(required)" : "(optional)"}
            <input type="date" value={manual.due} onChange={(event) => setManual((current) => ({ ...current, due: event.target.value }))}
              className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark" />
          </label>
        </div>
        <label className="block text-xs text-ink-soft dark:text-ink-soft-dark">Title
          <input value={manual.title} maxLength={200} onChange={(event) => setManual((current) => ({ ...current, title: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark" />
        </label>
        <label className="block text-xs text-ink-soft dark:text-ink-soft-dark">Details
          <textarea value={manual.detail} maxLength={1000} onChange={(event) => setManual((current) => ({ ...current, detail: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark" />
        </label>
        <button type="button" onClick={() => void saveManual()} disabled={busy === "manual" || !manual.title.trim() || (manual.kind === "reminder" && !manual.due)}
          className="rounded-full bg-ink px-4 py-2 text-xs font-medium text-paper disabled:opacity-40 dark:bg-ink-dark dark:text-paper-dark">Save locally</button>
      </div>
      {!notificationsEnabled && <p className="text-xs text-ink-faint dark:text-ink-faint-dark">Phone notifications are not connected yet. Reminders will appear in Alfred Today until they are.</p>}
      {loading && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>}
      {!loading && pending.length === 0 && <p className="rounded-2xl border border-line p-4 text-sm text-ink-soft dark:border-line-dark dark:text-ink-soft-dark">No forwarded messages waiting for review.</p>}
      {pending.map((item) => {
        const edit = edits[item.id] ?? defaultFiling(item);
        const coreItem = core[item.id];
        const corePending = coreItem?.approval_state === "pending";
        return (
          <article key={item.id} className="space-y-3 rounded-2xl border border-line p-4 dark:border-line-dark">
            <p className="whitespace-pre-wrap break-words text-sm text-ink dark:text-ink-dark">{item.body}</p>
            <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
              {item.state === "new" ? "Waiting for local analysis" : "Alfred's suggestion — review and edit"}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-ink-soft dark:text-ink-soft-dark">Type
                <select value={edit.kind} disabled={Boolean(coreItem?.approval_id)} onChange={(event) => change(item.id, { kind: event.target.value as InboxKind })}
                  className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink disabled:opacity-50 dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark">
                  <option value="clarify">Needs clarification</option>
                  <option value="note">Remember</option>
                  <option value="task">Task</option>
                  <option value="reminder">Reminder draft</option>
                </select>
              </label>
              <label className="text-xs text-ink-soft dark:text-ink-soft-dark">Date {edit.kind === "reminder" ? "(required)" : "(optional)"}
                <input type="date" value={edit.due} disabled={Boolean(coreItem?.approval_id)} onChange={(event) => change(item.id, { due: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink disabled:opacity-50 dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark" />
              </label>
            </div>
            <label className="block text-xs text-ink-soft dark:text-ink-soft-dark">Title
              <input value={edit.title} maxLength={200} disabled={Boolean(coreItem?.approval_id)} onChange={(event) => change(item.id, { title: event.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink disabled:opacity-50 dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark" />
            </label>
            <label className="block text-xs text-ink-soft dark:text-ink-soft-dark">Details
              <textarea value={edit.detail} maxLength={1000} disabled={Boolean(coreItem?.approval_id)} onChange={(event) => change(item.id, { detail: event.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-paper-raised p-2 text-sm text-ink disabled:opacity-50 dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark" />
            </label>
            {edit.kind === "reminder" && <p className="text-xs text-ink-faint dark:text-ink-faint-dark">Date-only reminders are checked at the configured UK morning hour. {notificationsEnabled ? "A generic phone alert will be sent when due." : "Phone alerts are not connected yet."}</p>}
            {coreItem?.approval_id && <div className="rounded-xl bg-paper-raised p-3 text-xs dark:bg-paper-raised-dark">
              <p className="font-medium text-ink dark:text-ink-dark">Core proposal: {coreItem.approval_state ?? "created"}</p>
              <p className="mt-1 text-ink-faint dark:text-ink-faint-dark">The reviewed title/date are now locked to this exact approval scope.</p>
              {corePending && <div className="mt-2 flex gap-3">
                <button type="button" disabled={busy === `core:${item.id}`} onClick={() => void resolveCore(item, true)} className="rounded-full bg-ink px-4 py-2 font-medium text-paper disabled:opacity-40 dark:bg-ink-dark dark:text-paper-dark">Approve Core action</button>
                <button type="button" disabled={busy === `core:${item.id}`} onClick={() => void resolveCore(item, false)} className="underline text-claude disabled:opacity-40">Reject</button>
              </div>}
            </div>}
            <div className="flex flex-wrap gap-3 text-xs">
              <button type="button" onClick={() => void save(item)} disabled={busy === item.id || Boolean(coreItem?.approval_id) || edit.kind === "clarify" || !edit.title.trim() || (edit.kind === "reminder" && !edit.due)}
                className="rounded-full bg-ink px-4 py-2 font-medium text-paper disabled:opacity-40 dark:bg-ink-dark dark:text-paper-dark">Save locally</button>
              {(edit.kind === "task" || edit.kind === "reminder") && !coreItem?.approval_id && <button type="button" onClick={() => void dispatch(item)} disabled={busy === `core:${item.id}` || !edit.title.trim() || (edit.kind === "reminder" && !edit.due)}
                className="rounded-full border border-line px-4 py-2 font-medium text-ink disabled:opacity-40 dark:border-line-dark dark:text-ink-dark">Send to Alfred Core</button>}
              <button type="button" onClick={() => void analyse(item.id)} disabled={busy === item.id || Boolean(coreItem?.approval_id)} className="underline text-ink-soft disabled:opacity-40 dark:text-ink-soft-dark">Analyse again</button>
              <button type="button" onClick={() => void discard(item)} disabled={busy === item.id || Boolean(coreItem?.approval_id)} className="underline text-claude disabled:opacity-40">Discard</button>
            </div>
          </article>
        );
      })}
      {filed.length > 0 && <section className="space-y-2 pt-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Approved local items</h3>
        {filed.slice(0, 10).map((item) => <p key={item.source_id} className="text-sm text-ink-soft dark:text-ink-soft-dark">
          {item.title} <span className="text-xs text-ink-faint dark:text-ink-faint-dark">· {item.kind}{item.due ? ` · ${item.due}` : ""}</span>
        </p>)}
      </section>}
    </section>
  );
}
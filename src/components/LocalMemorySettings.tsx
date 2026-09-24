import { useEffect, useState, type FormEvent } from "react";
import { addLocalMemory, deleteLocalMemory, editLocalMemory, getLocalMemory, listLocalMemories, type LocalMemory } from "../integrations/local/api";

export function LocalMemorySettings() {
  const [items, setItems] = useState<LocalMemory[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<number>();
  const [correction, setCorrection] = useState("");

  useEffect(() => {
    let active = true;
    const target = Number(new URLSearchParams(window.location.search).get("memory"));
    Promise.all([listLocalMemories(), Number.isInteger(target) && target > 0 ? getLocalMemory(target).catch(() => null) : Promise.resolve(null)])
      .then(([rows, selected]) => { if (active) setItems(selected && !rows.some((row) => row.id === selected.id) ? [selected, ...rows] : rows); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Local memory unavailable"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const target = Number(new URLSearchParams(window.location.search).get("memory"));
    if (target > 0 && items.some((item) => item.id === target)) {
      document.getElementById(`memory-${target}`)?.scrollIntoView({ block: "center" });
    }
  }, [items]);

  async function search(event: FormEvent) {
    event.preventDefault();
    setError("");
    try { setItems(await listLocalMemories(query)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Search failed"); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      await addLocalMemory(value);
      setDraft("");
      setQuery("");
      setItems(await listLocalMemories());
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Save failed"); }
    finally { setBusy(false); }
  }

  async function remove(id: number) {
    if (!window.confirm("Forget this local memory?")) return;
    setBusy(true);
    setError("");
    try {
      await deleteLocalMemory(id);
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Delete failed"); }
    finally { setBusy(false); }
  }

  async function correct(id: number) {
    if (!correction.trim()) return;
    setBusy(true);
    setError("");
    try {
      await editLocalMemory(id, correction.trim());
      setItems((current) => current.map((item) => item.id === id ? { ...item, content: correction.trim() } : item));
      setEditing(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Correction failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-line p-4 dark:border-line-dark">
      <p className="text-xs text-ink-soft dark:text-ink-soft-dark">Saved on the Dell. Alfred may use matching memories for local answers; cloud requests exclude them.</p>
      <form onSubmit={save} className="flex gap-2">
        <input aria-label="New local memory" value={draft} onChange={(event) => setDraft(event.target.value)}
          placeholder="Something Alfred should remember" maxLength={4000}
          className="min-w-0 flex-1 rounded-xl border border-line bg-transparent px-3 py-2 text-sm dark:border-line-dark" />
        <button disabled={busy || !draft.trim()} className="rounded-xl bg-ink px-3 text-xs text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark">Save</button>
      </form>
      <form onSubmit={search} className="flex gap-2">
        <input aria-label="Search local memory" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Search memory" className="min-w-0 flex-1 rounded-xl border border-line bg-transparent px-3 py-2 text-sm dark:border-line-dark" />
        <button className="rounded-xl border border-line px-3 text-xs dark:border-line-dark">Search</button>
      </form>
      {error && <p role="alert" className="text-xs text-claude">{error}</p>}
      <ul className="space-y-2">
        {items.map((item) => <li id={`memory-${item.id}`} key={item.id} className="rounded-xl bg-paper-raised p-3 text-sm scroll-mt-4 dark:bg-paper-raised-dark">
          {editing === item.id ? <div className="space-y-2">
            <textarea aria-label="Correct saved memory" value={correction} onChange={(event) => setCorrection(event.target.value)} maxLength={4000} className="w-full rounded-lg border border-line bg-transparent p-2 dark:border-line-dark" />
            <button type="button" disabled={busy || !correction.trim()} onClick={() => void correct(item.id)} className="mr-3 text-xs underline">Save correction</button>
            <button type="button" onClick={() => setEditing(undefined)} className="text-xs underline">Cancel</button>
          </div> : <div className="flex items-start justify-between gap-3">
            <span className="whitespace-pre-wrap text-ink dark:text-ink-dark">{item.content}</span>
            <div className="flex shrink-0 gap-2"><button type="button" onClick={() => { setEditing(item.id); setCorrection(item.content); }} className="text-xs underline">Correct</button>
              <button type="button" disabled={busy} onClick={() => void remove(item.id)} aria-label={`Forget memory ${item.id}`} className="text-xs underline disabled:opacity-50">Forget</button></div>
          </div>}
        </li>)}
      </ul>
    </div>
  );
}

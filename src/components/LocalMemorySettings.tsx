import { useEffect, useState, type FormEvent } from "react";
import { addLocalMemory, deleteLocalMemory, listLocalMemories, type LocalMemory } from "../integrations/local/api";

export function LocalMemorySettings() {
  const [items, setItems] = useState<LocalMemory[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    listLocalMemories().then((rows) => { if (active) setItems(rows); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Local memory unavailable"); });
    return () => { active = false; };
  }, []);

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
        {items.map((item) => <li key={item.id} className="flex items-start justify-between gap-3 rounded-xl bg-paper-raised p-3 text-sm dark:bg-paper-raised-dark">
          <span className="whitespace-pre-wrap text-ink dark:text-ink-dark">{item.content}</span>
          <button type="button" disabled={busy} onClick={() => remove(item.id)}
            aria-label={`Forget memory ${item.id}`} className="shrink-0 text-xs text-ink-soft underline disabled:opacity-50 dark:text-ink-soft-dark">Forget</button>
        </li>)}
      </ul>
    </div>
  );
}

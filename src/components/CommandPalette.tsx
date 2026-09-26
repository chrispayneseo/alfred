import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppIcon } from "./AppIcon";

const commands = [
  { label: "Ask Alfred", hint: "Start a conversation", to: "/chat", icon: "spark" as const },
  { label: "Capture something", hint: "Note, task, reminder or idea", to: "/capture", icon: "plus" as const },
  { label: "Search Alfred", hint: "Memory, notes and saved context", to: "/library", icon: "search" as const },
  { label: "Open Activity", hint: "Approvals and things needing you", to: "/activity", icon: "activity" as const },
  { label: "Home", hint: "Your day at a glance", to: "/today", icon: "home" as const },
  { label: "Settings", hint: "Connections, permissions and preferences", to: "/settings", icon: "settings" as const },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setOpen((value) => !value);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((item) => (item.label + " " + item.hint).toLowerCase().includes(q)) : commands;
  }, [query]);

  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={() => setOpen(false)}>
    <div role="dialog" aria-modal="true" aria-label="Command palette" className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-2xl dark:border-line-dark dark:bg-paper-raised-dark" onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-3 border-b border-line px-4 dark:border-line-dark">
        <AppIcon name="search" />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What do you want to do?" className="h-14 w-full bg-transparent text-base outline-none placeholder:text-ink-faint dark:placeholder:text-ink-faint-dark" />
        <kbd className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-ink-faint dark:border-line-dark">ESC</kbd>
      </div>
      <div className="max-h-[55vh] overflow-y-auto p-2">
        {filtered.map((item) => <button key={item.to} onClick={() => { navigate(item.to); setOpen(false); setQuery(""); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-paper dark:hover:bg-paper-dark">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-paper text-ink-soft dark:bg-paper-dark dark:text-ink-soft-dark"><AppIcon name={item.icon} /></span>
          <span className="min-w-0"><span className="block text-sm font-medium">{item.label}</span><span className="block truncate text-xs text-ink-faint dark:text-ink-faint-dark">{item.hint}</span></span>
        </button>)}
      </div>
      <div className="border-t border-line px-4 py-2 text-[11px] text-ink-faint dark:border-line-dark dark:text-ink-faint-dark">⌘K from anywhere · Alfred shortcuts</div>
    </div>
  </div>;
}

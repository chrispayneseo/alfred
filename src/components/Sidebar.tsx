import { NavLink } from "react-router-dom";
import { SIDEBAR_WIDTH } from "../lib/layout";
import { AppIcon } from "./AppIcon";

const items = [
  { to: "/today", label: "Home", icon: "home" as const },
  { to: "/chat", label: "Alfred", icon: "spark" as const },
  { to: "/activity", label: "Activity", icon: "activity" as const },
  { to: "/library", label: "Library", icon: "library" as const },
];

export function Sidebar() {
  return <aside className={`fixed inset-y-0 left-0 z-20 hidden ${SIDEBAR_WIDTH} border-r border-line/80 bg-paper-raised/80 backdrop-blur-xl lg:flex lg:flex-col dark:border-line-dark dark:bg-paper-raised-dark/75`}>
    <div className="px-5 pt-[max(1.75rem,env(safe-area-inset-top))]">
      <div className="flex items-center gap-3 px-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-paper shadow-sm dark:bg-ink-dark dark:text-paper-dark"><AppIcon name="spark" size={17}/></span>
        <div><p className="text-sm font-semibold tracking-tight">Alfred</p><p className="text-[10px] uppercase tracking-[.14em] text-ink-faint dark:text-ink-faint-dark">Personal OS</p></div>
      </div>
      <nav className="mt-8" aria-label="Primary">
        <ul className="space-y-1">{items.map(item => <li key={item.to}><NavLink to={item.to} className={({isActive}) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${isActive ? "bg-paper text-ink shadow-sm dark:bg-paper-dark dark:text-ink-dark" : "text-ink-soft hover:bg-paper/60 hover:text-ink dark:text-ink-soft-dark dark:hover:bg-paper-dark/60 dark:hover:text-ink-dark"}`}><AppIcon name={item.icon}/><span>{item.label}</span></NavLink></li>)}</ul>
      </nav>
      <div className="my-6 border-t border-line/80 dark:border-line-dark" />
      <p className="px-3 text-[10px] font-medium uppercase tracking-[.14em] text-ink-faint dark:text-ink-faint-dark">Quick access</p>
      <div className="mt-2 space-y-1">
        <NavLink to="/capture" className="flex items-center gap-3 rounded-xl px-3 py-2 text-xs text-ink-soft hover:bg-paper/60 dark:text-ink-soft-dark dark:hover:bg-paper-dark/60"><AppIcon name="plus" size={16}/>Capture</NavLink>
        <NavLink to="/settings" className="flex items-center gap-3 rounded-xl px-3 py-2 text-xs text-ink-soft hover:bg-paper/60 dark:text-ink-soft-dark dark:hover:bg-paper-dark/60"><AppIcon name="settings" size={16}/>Settings</NavLink>
      </div>
    </div>
    <div className="mt-auto p-5">
      <div className="rounded-xl border border-line/70 bg-paper/50 p-3 dark:border-line-dark dark:bg-paper-dark/40">
        <div className="flex items-center justify-between"><span className="text-xs font-medium">Alfred ready</span><span className="h-2 w-2 rounded-full bg-chatgpt"/></div>
        <p className="mt-1 text-[10px] text-ink-faint dark:text-ink-faint-dark">⌘K for commands</p>
      </div>
    </div>
  </aside>;
}

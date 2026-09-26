import { NavLink } from "react-router-dom";
import { AppIcon } from "./AppIcon";

const tabs = [
  { to: "/today", label: "Home", icon: "home" as const },
  { to: "/chat", label: "Alfred", icon: "spark" as const },
  { to: "/activity", label: "Activity", icon: "activity" as const },
  { to: "/library", label: "Library", icon: "library" as const },
];

export function TabBar() {
  return <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line/70 bg-paper-raised/90 pb-[max(0.45rem,env(safe-area-inset-bottom))] backdrop-blur-xl lg:hidden dark:border-line-dark dark:bg-paper-raised-dark/90" aria-label="Primary">
    <ul className="mx-auto grid max-w-lg grid-cols-4 px-2 pt-1.5">{tabs.map(tab => <li key={tab.to}><NavLink to={tab.to} className={({isActive}) => `flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl text-[10px] font-medium transition-colors ${isActive ? "text-ink dark:text-ink-dark" : "text-ink-faint dark:text-ink-faint-dark"}`}><AppIcon name={tab.icon} size={19}/>{tab.label}</NavLink></li>)}</ul>
  </nav>;
}

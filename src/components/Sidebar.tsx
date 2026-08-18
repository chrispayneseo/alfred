import { NavLink } from "react-router-dom";
import { SIDEBAR_WIDTH } from "../lib/layout";

// Desktop-only counterpart to TabBar (hidden below `lg`, see TabBar's
// `lg:hidden`) — a bottom tab bar is a mobile/thumb-reach pattern that reads
// as an odd disconnected strip on a laptop, so at desktop widths navigation
// moves to a persistent left sidebar instead. Mirrors TabBar's four routes
// and adds Settings, which on mobile only lives behind Today's header gear
// icon (no space for a fifth tab there) but has room to be a first-class
// nav item once space isn't scarce.
const items = [
  {
    to: "/today",
    label: "Today",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4.5" width="18" height="16" rx="2" />
        <path d="M3 9.5h18M8 3v3M16 3v3" />
      </svg>
    ),
  },
  {
    to: "/chat",
    label: "Chat",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 5.5h16v11H8.5L4 20.5z" />
      </svg>
    ),
  },
  {
    to: "/capture",
    label: "Capture",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    ),
  },
  {
    to: "/browse",
    label: "Browse",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    to: "/feed",
    label: "Feed",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 11a9 9 0 0 1 9 9" />
        <path d="M4 4a16 16 0 0 1 16 16" />
        <circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    to: "/settings",
    label: "Settings",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="12" cy="12" r="3" />
        <path
          strokeLinecap="round"
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        />
      </svg>
    ),
  },
] as const;

export function Sidebar() {
  return (
    <nav
      className={`fixed inset-y-0 left-0 z-20 hidden ${SIDEBAR_WIDTH} border-r border-line bg-paper-raised/60 lg:flex lg:flex-col dark:border-line-dark dark:bg-paper-raised-dark/40`}
      aria-label="Primary"
    >
      <p className="px-7 pt-[max(2rem,env(safe-area-inset-top))] text-sm font-medium tracking-tight text-ink dark:text-ink-dark">
        Alfred
      </p>
      <ul className="mt-8 flex flex-col gap-1 px-4">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-paper text-ink dark:bg-paper-dark dark:text-ink-dark"
                    : "text-ink-faint hover:text-ink-soft dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
                }`
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

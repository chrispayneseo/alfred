import { NavLink } from "react-router-dom";
import { SIDEBAR_WIDTH } from "../lib/layout";

const items = [
  { to: "/today", label: "Today" },
  { to: "/chat", label: "Ask Alfred" },
  { to: "/inbox", label: "Alfred Inbox" },
  { to: "/search", label: "Search Alfred" },
  { to: "/capture", label: "Capture" },
  { to: "/browse", label: "Browse" },
  { to: "/feed", label: "Feed" },
  { to: "/settings", label: "Settings" },
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
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

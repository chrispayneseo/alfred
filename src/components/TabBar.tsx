import { NavLink } from "react-router-dom";

const tabs = [
  { to: "/today", label: "Today" },
  { to: "/chat", label: "Ask" },
  { to: "/inbox", label: "Inbox" },
  { to: "/search", label: "Search" },
  { to: "/capture", label: "Capture" },
] as const;

export function TabBar() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper-raised/95 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden dark:border-line-dark dark:bg-paper-raised-dark/95"
      aria-label="Primary"
    >
      <ul className="mx-auto flex max-w-lg justify-around px-1 pt-2">
        {tabs.map((tab) => (
          <li key={tab.to}>
            <NavLink
              to={tab.to}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
                  isActive
                    ? "text-ink dark:text-ink-dark"
                    : "text-ink-faint dark:text-ink-faint-dark"
                }`
              }
            >
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

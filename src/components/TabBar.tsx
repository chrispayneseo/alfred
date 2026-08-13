import { NavLink } from "react-router-dom";

const tabs = [
  { to: "/today", label: "Today" },
  { to: "/chat", label: "Chat" },
  { to: "/capture", label: "Capture" },
  { to: "/browse", label: "Browse" },
] as const;

export function TabBar() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper-raised/95 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur dark:border-line-dark dark:bg-paper-raised-dark/95"
      aria-label="Primary"
    >
      <ul className="mx-auto flex max-w-md justify-around px-2 pt-2">
        {tabs.map((tab) => (
          <li key={tab.to}>
            <NavLink
              to={tab.to}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 rounded-lg px-4 py-1.5 text-xs transition-colors ${
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

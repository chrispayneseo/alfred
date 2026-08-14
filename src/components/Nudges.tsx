import { useEffect, useState } from "react";
import { checkNudges, type Nudge } from "../integrations/nudges/api";

type NudgesState = "loading" | "ready" | "error";

function formatDue(due?: string): string {
  if (!due) return "";
  return new Date(due).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Nudges() {
  const [state, setState] = useState<NudgesState>("loading");
  const [nudges, setNudges] = useState<Nudge[]>([]);

  useEffect(() => {
    checkNudges()
      .then((items) => {
        setNudges(items);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  if (state === "loading") {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Checking for overdue tasks…</p>;
  }

  if (state === "error") {
    return <p className="text-sm text-claude">Couldn't check for nudges right now.</p>;
  }

  if (nudges.length === 0) {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing overdue.</p>;
  }

  return (
    <div>
      <span className="mb-3 inline-block rounded-full bg-paper-raised px-2.5 py-0.5 text-[11px] font-medium text-ink-soft dark:bg-paper-raised-dark dark:text-ink-soft-dark">
        {nudges.length} overdue
      </span>
      <ul className="space-y-3">
        {nudges.map((nudge) => (
          <li key={nudge.taskId} className="border-b border-line pb-3 last:border-0 dark:border-line-dark">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm text-ink dark:text-ink-dark">{nudge.title}</p>
              {nudge.due && (
                <span className="shrink-0 text-[11px] text-ink-faint dark:text-ink-faint-dark">{formatDue(nudge.due)}</span>
              )}
            </div>
            <p className="text-xs text-ink-soft dark:text-ink-soft-dark">{nudge.message}</p>
            {nudge.projectName && (
              <p className="mt-0.5 text-[11px] text-ink-faint dark:text-ink-faint-dark">{nudge.projectName}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

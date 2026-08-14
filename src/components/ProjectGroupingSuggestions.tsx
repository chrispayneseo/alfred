import { useEffect, useState } from "react";
import {
  acceptGrouping,
  checkProjectGroupings,
  dismissGrouping,
  type PendingGrouping,
} from "../integrations/projectGroupings/api";

/** Silent when there's nothing pending — same philosophy as
 * RecurringSuggestions: this doubles as the check-on-open trigger, but
 * stays quiet unless there's actually something to show. */
export function ProjectGroupingSuggestions() {
  const [groupings, setGroupings] = useState<PendingGrouping[]>();
  const [busyId, setBusyId] = useState<string>();

  useEffect(() => {
    checkProjectGroupings()
      .then(setGroupings)
      .catch(() => setGroupings([]));
  }, []);

  async function handleAccept(id: string) {
    setBusyId(id);
    try {
      await acceptGrouping(id);
      setGroupings((prev) => prev?.filter((g) => g.id !== id));
    } finally {
      setBusyId(undefined);
    }
  }

  async function handleDismiss(id: string) {
    setBusyId(id);
    try {
      await dismissGrouping(id);
      setGroupings((prev) => prev?.filter((g) => g.id !== id));
    } finally {
      setBusyId(undefined);
    }
  }

  if (!groupings || groupings.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
        Might be a project
      </h2>
      <ul className="space-y-3">
        {groupings.map((g) => (
          <li key={g.id} className="rounded-2xl border border-line px-4 py-3.5 dark:border-line-dark">
            <p className="text-sm text-ink dark:text-ink-dark">{g.suggestedName}</p>
            <p className="mt-0.5 text-xs text-ink-faint dark:text-ink-faint-dark">
              {g.items.length} related items · Best guess based on past pattern
            </p>
            <p className="mt-1.5 text-xs text-ink-soft dark:text-ink-soft-dark">{g.reason}</p>
            <ul className="mt-2 space-y-0.5">
              {g.items.map((item) => (
                <li key={item.id} className="text-xs text-ink-faint dark:text-ink-faint-dark">
                  · {item.title}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => handleAccept(g.id)}
                disabled={busyId === g.id}
                className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
              >
                Group these together
              </button>
              <button
                onClick={() => handleDismiss(g.id)}
                disabled={busyId === g.id}
                className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

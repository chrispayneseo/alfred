import { useEffect, useState } from "react";
import {
  acceptSuggestion,
  checkRecurring,
  dismissSuggestion,
  type PendingSuggestion,
} from "../integrations/recurring/api";

const CADENCE_LABEL = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", quarterly: "Quarterly" } as const;

/** Silent when there's nothing pending — matches WeeklyDigestTeaser's
 * philosophy: this doubles as the check-on-open trigger, but stays quiet
 * unless there's actually something to show, keeping it "an occasional
 * helpful observation, not a constant stream." */
export function RecurringSuggestions() {
  const [suggestions, setSuggestions] = useState<PendingSuggestion[]>();
  const [busyId, setBusyId] = useState<string>();

  useEffect(() => {
    checkRecurring()
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, []);

  async function handleAccept(id: string) {
    setBusyId(id);
    try {
      await acceptSuggestion(id);
      setSuggestions((prev) => prev?.filter((s) => s.id !== id));
    } finally {
      setBusyId(undefined);
    }
  }

  async function handleDismiss(id: string) {
    setBusyId(id);
    try {
      await dismissSuggestion(id);
      setSuggestions((prev) => prev?.filter((s) => s.id !== id));
    } finally {
      setBusyId(undefined);
    }
  }

  if (!suggestions || suggestions.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
        Noticed a pattern
      </h2>
      <ul className="space-y-3">
        {suggestions.map((s) => (
          <li key={s.id} className="rounded-2xl border border-line px-4 py-3.5 dark:border-line-dark">
            <p className="text-sm text-ink dark:text-ink-dark">{s.title}</p>
            <p className="mt-0.5 text-xs text-ink-faint dark:text-ink-faint-dark">
              {CADENCE_LABEL[s.cadence]} · Best guess based on past pattern
            </p>
            <p className="mt-1.5 text-xs text-ink-soft dark:text-ink-soft-dark">{s.reason}</p>
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => handleAccept(s.id)}
                disabled={busyId === s.id}
                className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
              >
                Create recurring task
              </button>
              <button
                onClick={() => handleDismiss(s.id)}
                disabled={busyId === s.id}
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

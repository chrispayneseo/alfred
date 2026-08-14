import { useState } from "react";
import { scanForRecurringPatterns } from "../integrations/recurring/api";

export function RecurringTaskSettings() {
  const [state, setState] = useState<"idle" | "scanning" | "done">("idle");
  const [result, setResult] = useState<number>();
  const [error, setError] = useState<string>();

  async function handleScan() {
    setState("scanning");
    setError(undefined);
    try {
      const { created } = await scanForRecurringPatterns();
      setResult(created);
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't scan right now.");
      setState("idle");
    }
  }

  return (
    <div>
      <p className="mb-2 text-xs text-ink-soft dark:text-ink-soft-dark">
        Alfred occasionally checks Tasks and email for things that look recurring — this also happens automatically,
        at most once a week. Suggestions appear on Today with the option to accept or dismiss.
      </p>
      <button
        onClick={handleScan}
        disabled={state === "scanning"}
        className="rounded-full border border-line px-4 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-ink-faint disabled:opacity-50 dark:border-line-dark dark:text-ink-soft-dark dark:hover:border-ink-faint-dark"
      >
        {state === "scanning" ? "Scanning…" : "Scan now"}
      </button>
      {state === "done" && result !== undefined && (
        <p className="mt-2 text-xs text-ink-faint dark:text-ink-faint-dark">
          {result === 0 ? "Nothing new found." : `Found ${result} new suggestion${result === 1 ? "" : "s"} — check Today.`}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-claude">{error}</p>}
    </div>
  );
}

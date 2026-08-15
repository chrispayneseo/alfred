import { useState } from "react";
import { locationDecision, setLocationEnabled } from "../lib/geolocation";

/** Shows once, the first time the app ever opens — after that,
 * locationDecision() is always "enabled" or "disabled" and this renders
 * nothing. The actual browser permission prompt (if "Allow" is chosen)
 * happens separately, triggered by the caller's onAllow. */
export function LocationPrompt({ onAllow }: { onAllow: () => void }) {
  const [visible, setVisible] = useState(() => locationDecision() === "undecided");
  if (!visible) return null;

  function allow() {
    setLocationEnabled(true);
    setVisible(false);
    onAllow();
  }

  function notNow() {
    setLocationEnabled(false);
    setVisible(false);
  }

  return (
    <div className="mb-6 rounded-xl border border-line px-4 py-3 dark:border-line-dark">
      <p className="text-xs text-ink-soft dark:text-ink-soft-dark">
        Alfred uses your location for weather and local context — fetched only while the app is open, never in the
        background. You can change this anytime in Settings.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={allow}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper dark:bg-ink-dark dark:text-paper-dark"
        >
          Allow
        </button>
        <button
          onClick={notNow}
          className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

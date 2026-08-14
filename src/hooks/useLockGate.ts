import { useEffect, useRef, useState } from "react";
import { RELOCK_AFTER_MS, isLockEnabled } from "../lib/lock";

/** Locked on cold start whenever the lock is enabled. Re-locks after coming
 * back from being backgrounded for more than RELOCK_AFTER_MS — a brief
 * app-switch doesn't force a re-unlock, leaving it backgrounded for real does. */
export function useLockGate() {
  const [locked, setLocked] = useState(() => isLockEnabled());
  const hiddenAtRef = useRef<number | null>(null);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
        return;
      }
      if (hiddenAtRef.current === null) return;
      const elapsed = Date.now() - hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (elapsed > RELOCK_AFTER_MS && isLockEnabled()) setLocked(true);
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return { locked, unlock: () => setLocked(false) };
}

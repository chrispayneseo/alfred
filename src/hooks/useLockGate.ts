import { useEffect, useRef, useState } from "react";
import { consumeRelockSuppression, RELOCK_AFTER_MS, isLockEnabled } from "../lib/lock";

/** Locked on cold start whenever the lock is enabled. Re-locks after coming
 * back from being backgrounded for more than RELOCK_AFTER_MS — a brief
 * app-switch doesn't force a re-unlock, leaving it backgrounded for real does.
 *
 * Also consumed here, not just in the visibilitychange handler below: if the
 * OS reloaded the page while backgrounded (see lock.ts's comment on
 * expectBackgrounding), this component mounts fresh already-visible, so no
 * hidden→visible transition ever fires for the handler to catch. This is the
 * only place a reload-driven return gets a chance to suppress the lock. */
export function useLockGate() {
  const [locked, setLocked] = useState(() => {
    // Always consume, even if the lock turns out to be disabled — this is a
    // one-shot flag tied to a specific expectBackgrounding() call, not
    // something that should linger into a later mount.
    const suppressed = consumeRelockSuppression();
    return isLockEnabled() && !suppressed;
  });
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
      if (consumeRelockSuppression()) return;
      if (elapsed > RELOCK_AFTER_MS && isLockEnabled()) setLocked(true);
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return { locked, unlock: () => setLocked(false) };
}

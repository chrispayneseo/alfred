import { useCallback, useRef, useState } from "react";

interface PendingUndo {
  /** Distinguishes toast instances so a stale timer can't clear a newer one. */
  token: string;
  message: string;
  undo: () => void;
}

const DEFAULT_DURATION_MS = 6000;

/** Backs the app's uniform "delete → toast with Undo" pattern (Tasks, Notes,
 * Recipes, Projects all use this the same way, in place of a pre-delete
 * confirm() dialog) — see BrowseScreen/TodayScreen's removeX functions for
 * the optimistic-delete-then-trigger call sites. Only one toast is tracked
 * at a time; triggering a new one before the last expires replaces it (the
 * superseded item is still safely deleted/archived, it just loses its own
 * "Undo" affordance in the UI once a newer toast takes over). */
export function useUndoableAction() {
  const [pending, setPending] = useState<PendingUndo | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const trigger = useCallback((message: string, undo: () => void, duration = DEFAULT_DURATION_MS) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const token = Math.random().toString(36).slice(2);
    setPending({ token, message, undo });
    timerRef.current = setTimeout(() => {
      setPending((p) => (p?.token === token ? null : p));
    }, duration);
  }, []);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setPending(null);
  }, []);

  const runUndo = useCallback(() => {
    if (!pending) return;
    pending.undo();
    clear();
  }, [pending, clear]);

  return { pending, trigger, runUndo, dismiss: clear };
}

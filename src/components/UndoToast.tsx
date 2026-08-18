import { CONTENT_MAX_WIDTH, CONTENT_PADDING_X, SIDEBAR_OFFSET } from "../lib/layout";

interface UndoToastProps {
  message: string;
  onUndo: () => void;
}

// Mirrors CaptureFab's technique for staying aligned with the content
// column instead of the raw viewport (see CaptureFab.tsx for why) — same
// sidebar offset and max-width, just centered instead of bottom-right.
export function UndoToast({ message, onUndo }: UndoToastProps) {
  return (
    <div className={`pointer-events-none fixed inset-x-0 bottom-16 z-30 lg:bottom-8 ${SIDEBAR_OFFSET}`}>
      <div className={`mx-auto flex ${CONTENT_MAX_WIDTH} justify-center ${CONTENT_PADDING_X}`}>
        <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-ink px-4 py-2.5 text-xs text-paper shadow-lg shadow-black/10 dark:bg-ink-dark dark:text-paper-dark">
          <span>{message}</span>
          <button onClick={onUndo} className="font-medium underline underline-offset-2">
            Undo
          </button>
        </div>
      </div>
    </div>
  );
}

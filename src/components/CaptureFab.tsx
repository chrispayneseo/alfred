import { useLocation, useNavigate } from "react-router-dom";
import { CONTENT_MAX_WIDTH, CONTENT_PADDING_X, SIDEBAR_OFFSET } from "../lib/layout";

// The button needs `position: fixed` so it stays put while the page scrolls
// (an `absolute` button inside the routed content would scroll away with
// it), but a bare `fixed bottom-4 right-4` anchors to the raw viewport
// corner — fine on a phone where the content fills the viewport, but on a
// wide desktop window that leaves the button stranded far from the actual
// (narrower, sidebar-offset) content column. The fix: a full-viewport,
// `pointer-events-none` overlay that reproduces the exact box the content
// lives in (same sidebar offset + max-width + padding as Screen.tsx), and
// the real button sits `absolute` inside *that* — so it's still visually
// fixed to the viewport, but its right edge lines up with the content's
// right edge instead of the browser window's.
export function CaptureFab() {
  const navigate = useNavigate();
  const location = useLocation();

  if (location.pathname === "/capture" || location.pathname === "/chat") return null;

  return (
    <div className={`pointer-events-none fixed inset-0 z-20 ${SIDEBAR_OFFSET}`}>
      <div className={`relative mx-auto h-full ${CONTENT_MAX_WIDTH} ${CONTENT_PADDING_X}`}>
        <button
          type="button"
          onClick={() => navigate("/capture")}
          aria-label="Capture a thought"
          className="pointer-events-auto absolute bottom-20 right-5 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-paper shadow-lg shadow-black/10 transition-transform active:scale-95 lg:bottom-10 lg:right-10 dark:bg-ink-dark dark:text-paper-dark"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    </div>
  );
}

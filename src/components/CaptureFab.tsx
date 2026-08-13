import { useLocation, useNavigate } from "react-router-dom";

export function CaptureFab() {
  const navigate = useNavigate();
  const location = useLocation();

  if (location.pathname === "/capture") return null;

  return (
    <button
      type="button"
      onClick={() => navigate("/capture")}
      aria-label="Capture a thought"
      className="fixed bottom-20 right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-paper shadow-lg shadow-black/10 transition-transform active:scale-95 dark:bg-ink-dark dark:text-paper-dark"
    >
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  );
}

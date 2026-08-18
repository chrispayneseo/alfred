import { useEffect, useState } from "react";

// Matches Tailwind's `lg` breakpoint — the same width the rest of the app
// switches to the sidebar/wide-content desktop layout at, so this stays
// consistent with everywhere else that distinction is made.
const QUERY = "(min-width: 1024px)";

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const handler = () => setIsDesktop(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isDesktop;
}

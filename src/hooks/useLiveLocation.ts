import { useCallback, useEffect, useState } from "react";
import { getCurrentPosition, locationDecision, type Coords } from "../lib/geolocation";

/** Fetches device location on mount and again whenever the app becomes
 * visible after being backgrounded (switching back to the installed PWA) —
 * never in the true background, matching the platform constraint. Does
 * nothing until the user has opted in (locationDecision() === "enabled");
 * callers needing to prompt for that decision use `refetch` once the user
 * agrees. Always resolves to undefined rather than throwing on
 * denial/failure, so every caller can just fall back to the fixed home
 * location. */
export function useLiveLocation() {
  const [coords, setCoords] = useState<Coords>();

  const refetch = useCallback(() => {
    if (locationDecision() !== "enabled") return;
    getCurrentPosition().then(setCoords);
  }, []);

  useEffect(() => {
    refetch();
    function handleVisibilityChange() {
      if (!document.hidden) refetch();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [refetch]);

  return { coords, refetch };
}

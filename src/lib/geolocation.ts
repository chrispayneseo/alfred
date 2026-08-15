// PWAs can't reliably track location in the true background (app closed or
// unfocused) — that's a browser/OS limitation, not something worth working
// around with a service worker. Location is only ever fetched while the
// app is actually open (on load, and on resuming from the background —
// see useLiveLocation.ts), for the current session, never persisted.
const ENABLED_KEY = "alfred.location.enabled";

export interface Coords {
  lat: number;
  lon: number;
}

/** "1"/"0" once the user has decided; absent means "never asked" — the
 * priming prompt shows once, then this always reflects their choice. */
export function locationDecision(): "enabled" | "disabled" | "undecided" {
  const raw = localStorage.getItem(ENABLED_KEY);
  if (raw === "1") return "enabled";
  if (raw === "0") return "disabled";
  return "undecided";
}

export function setLocationEnabled(enabled: boolean): void {
  localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
}

export function isGeolocationSupported(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

/** Resolves to coordinates, or undefined on denial/timeout/unsupported —
 * never rejects, so callers can always fall back to the fixed home
 * location without a try/catch. Desktop location is typically IP-based
 * and far less precise than a phone's GPS; nothing here can improve that,
 * so UI copy should never imply desktop precision. */
export function getCurrentPosition(): Promise<Coords | undefined> {
  if (!isGeolocationSupported()) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => resolve(undefined),
      { timeout: 10_000, maximumAge: 5 * 60_000 }
    );
  });
}

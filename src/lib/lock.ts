import { hasPinSet, clearPin } from "./pin";
import { hasBiometricRegistered, clearBiometric } from "./webauthn";

const ENABLED_KEY = "alfred.lock.enabled";

// How long the app can sit backgrounded before returning to it re-locks.
// A brief app-switch (checking a code, taking a call) shouldn't force a
// re-unlock; leaving it backgrounded for real should.
export const RELOCK_AFTER_MS = 60_000;

// A native OS picker (camera, file chooser) backgrounds the app for as long
// as the user needs to frame a shot or browse photos — often well past
// RELOCK_AFTER_MS on its own. That's not "left unattended," it's a
// continuation of something the user just did from inside the (already
// unlocked) app, so it shouldn't force a re-unlock. Call expectBackgrounding()
// right before triggering the picker; useLockGate consumes it on return.
//
// Backed by sessionStorage, not a plain module variable: opening the native
// camera is exactly the kind of memory pressure that makes iOS/Android
// silently reload a backgrounded PWA's page before handing control back. A
// module variable doesn't survive that reload — sessionStorage does (it's
// tied to the tab's browsing context, not the JS heap), so the suppression
// still holds even if the app's whole JS state was wiped and rebuilt while
// the camera was open. Expiring after SUPPRESS_WINDOW_MS keeps a
// never-consumed flag (e.g. the user backed out of the picker and the app
// was later reopened cold) from suppressing a real relock indefinitely.
const SUPPRESS_KEY = "alfred.lock.suppressUntil";
const SUPPRESS_WINDOW_MS = 5 * 60 * 1000;

export function expectBackgrounding(): void {
  sessionStorage.setItem(SUPPRESS_KEY, String(Date.now() + SUPPRESS_WINDOW_MS));
}

export function consumeRelockSuppression(): boolean {
  const raw = sessionStorage.getItem(SUPPRESS_KEY);
  sessionStorage.removeItem(SUPPRESS_KEY);
  return raw !== null && Date.now() < Number(raw);
}

export function isLockEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "1";
}

/** Lock can only be turned on once a PIN fallback exists — biometric alone
 * would leave the user locked out the moment it's unavailable or fails. */
export function canEnableLock(): boolean {
  return hasPinSet();
}

export function setLockEnabled(enabled: boolean): void {
  if (enabled && !canEnableLock()) throw new Error("Set a backup PIN before enabling the lock.");
  localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
}

/** Fully resets lock configuration — used when the user turns the lock off
 * for good, not just each time it's unlocked. */
export function resetLock(): void {
  localStorage.setItem(ENABLED_KEY, "0");
  clearPin();
  clearBiometric();
}

export function lockStatus() {
  return {
    enabled: isLockEnabled(),
    biometricRegistered: hasBiometricRegistered(),
    pinSet: hasPinSet(),
  };
}

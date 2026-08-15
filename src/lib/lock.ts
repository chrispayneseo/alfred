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
let relockSuppressed = false;

export function expectBackgrounding(): void {
  relockSuppressed = true;
}

export function consumeRelockSuppression(): boolean {
  const wasSuppressed = relockSuppressed;
  relockSuppressed = false;
  return wasSuppressed;
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

// Shared in-memory per-account health, updated wherever a Google API call is
// actually made (calendar, gmail sync/scan, Q&A context) and read by the
// Settings accounts list — so Settings can show "needs reconnecting" without
// making its own live Google calls just to render a status.
export type AccountHealth = "ok" | "reconnect_required";

const status = new Map<string, AccountHealth>();

export function markAccountOk(email: string): void {
  status.set(email, "ok");
}

export function markAccountNeedsReconnect(email: string): void {
  status.set(email, "reconnect_required");
}

/** Defaults to "ok" for an account that's never been tried yet (e.g. just connected). */
export function getAccountHealth(email: string): AccountHealth {
  return status.get(email) ?? "ok";
}

export function clearAccountHealth(email: string): void {
  status.delete(email);
}

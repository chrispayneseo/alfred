export interface GoogleAccount {
  email: string;
  status: "ok" | "reconnect_required";
}

export async function fetchGoogleAccounts(): Promise<GoogleAccount[]> {
  const res = await fetch("/api/google/accounts");
  if (!res.ok) return [];
  return res.json();
}

export async function disconnectGoogleAccount(email: string): Promise<void> {
  const res = await fetch(`/api/google/accounts/${encodeURIComponent(email)}/disconnect`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
}

export function reconnectGoogleAccountUrl(email: string): string {
  return `/api/google/auth/start?email=${encodeURIComponent(email)}`;
}

export const CONNECT_ANOTHER_ACCOUNT_URL = "/api/google/auth/start";

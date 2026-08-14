// PIN fallback for when biometric auth isn't available or fails. Only a
// salted SHA-256 hash is ever stored — never the PIN itself.
const STORAGE_KEY = "alfred.lock.pin";

interface StoredPin {
  salt: string;
  hash: string;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${pin}`));
  return bytesToHex(digest);
}

export function hasPinSet(): boolean {
  return Boolean(localStorage.getItem(STORAGE_KEY));
}

export function clearPin(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export async function setPin(pin: string): Promise<void> {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const hash = await hashPin(pin, salt);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ salt, hash } satisfies StoredPin));
}

export async function verifyPin(pin: string): Promise<boolean> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  const { salt, hash } = JSON.parse(raw) as StoredPin;
  return (await hashPin(pin, salt)) === hash;
}

// Client-side-only WebAuthn: registers and verifies a platform authenticator
// (Face/Touch ID, fingerprint) purely in the browser, no server round-trip.
// This is a deliberate choice, not an oversight — Alfred has no real
// multi-user backend, so the threat model is someone picking up your
// unlocked device, not a remote attacker forging a login. A successful
// navigator.credentials.get() can only happen via the OS's secure hardware
// actually matching your biometric, which is the property that matters here.
const RP_NAME = "Alfred";
const STORAGE_KEY = "alfred.lock.credentialId";

function randomChallenge(): BufferSource {
  return crypto.getRandomValues(new Uint8Array(32)) as BufferSource;
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function hasBiometricRegistered(): boolean {
  return Boolean(localStorage.getItem(STORAGE_KEY));
}

export function clearBiometric(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Registers a platform credential and stores its id locally for later assertions. */
export async function registerBiometric(): Promise<void> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: RP_NAME, id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)) as BufferSource,
        name: "alfred-local-user",
        displayName: "Alfred",
      },
      challenge: randomChallenge(),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60_000,
      attestation: "none",
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Biometric registration was cancelled.");
  const id = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
  localStorage.setItem(STORAGE_KEY, id);
}

/** Prompts for the registered biometric. Resolves on success, throws otherwise
 * (cancelled, failed, no authenticator) — callers should fall back to PIN. */
export async function verifyBiometric(): Promise<void> {
  const storedId = localStorage.getItem(STORAGE_KEY);
  if (!storedId) throw new Error("No biometric credential registered.");
  const rawId = Uint8Array.from(atob(storedId), (c) => c.charCodeAt(0));

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      allowCredentials: [{ id: rawId, type: "public-key" }],
      userVerification: "required",
      timeout: 60_000,
    },
  });

  if (!assertion) throw new Error("Biometric verification failed.");
}

import { useEffect, useRef, useState } from "react";
import { verifyPin } from "../lib/pin";
import { hasBiometricRegistered, verifyBiometric } from "../lib/webauthn";

type Mode = "biometric" | "pin";

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const biometricAvailable = hasBiometricRegistered();
  const [mode, setMode] = useState<Mode>(biometricAvailable ? "biometric" : "pin");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const triedAutomatically = useRef(false);

  async function tryBiometric(silent: boolean) {
    setChecking(true);
    setError(undefined);
    try {
      await verifyBiometric();
      onUnlock();
    } catch {
      if (!silent) setError("Couldn't verify — try again, or use your PIN.");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (biometricAvailable && !triedAutomatically.current) {
      triedAutomatically.current = true;
      // Best-effort — some browsers allow this without an explicit tap right
      // after the app opens; if blocked, the visible "Unlock" button below
      // still works normally.
      void tryBiometric(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePinSubmit(e: React.FormEvent) {
    e.preventDefault();
    setChecking(true);
    setError(undefined);
    const ok = await verifyPin(pin);
    setChecking(false);
    if (ok) {
      onUnlock();
    } else {
      setError("Incorrect PIN.");
      setPin("");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-paper px-6 dark:bg-paper-dark">
      <div className="w-full max-w-xs text-center">
        <h1 className="mb-1 text-lg font-medium tracking-tight text-ink dark:text-ink-dark">Alfred is locked</h1>
        <p className="mb-8 text-sm text-ink-soft dark:text-ink-soft-dark">
          {mode === "biometric" ? "Unlock to continue." : "Enter your PIN to continue."}
        </p>

        {mode === "biometric" && (
          <>
            <button
              onClick={() => tryBiometric(false)}
              disabled={checking}
              className="mb-4 w-full rounded-full bg-ink px-4 py-3 text-sm font-medium text-paper disabled:opacity-60 dark:bg-ink-dark dark:text-paper-dark"
            >
              {checking ? "Checking…" : "Unlock with biometrics"}
            </button>
            <button
              onClick={() => {
                setMode("pin");
                setError(undefined);
              }}
              className="text-xs text-ink-faint underline dark:text-ink-faint-dark"
            >
              Use PIN instead
            </button>
          </>
        )}

        {mode === "pin" && (
          <form onSubmit={handlePinSubmit}>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="PIN"
              className="mb-4 w-full rounded-xl border border-line bg-paper-raised px-4 py-3 text-center text-lg tracking-[0.5em] text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
            />
            <button
              type="submit"
              disabled={checking || pin.length < 4}
              className="mb-4 w-full rounded-full bg-ink px-4 py-3 text-sm font-medium text-paper disabled:opacity-40 dark:bg-ink-dark dark:text-paper-dark"
            >
              Unlock
            </button>
            {biometricAvailable && (
              <button
                type="button"
                onClick={() => {
                  setMode("biometric");
                  setError(undefined);
                }}
                className="text-xs text-ink-faint underline dark:text-ink-faint-dark"
              >
                Use biometrics instead
              </button>
            )}
          </form>
        )}

        {error && <p className="mt-4 text-xs text-claude">{error}</p>}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { canEnableLock, lockStatus, resetLock, setLockEnabled } from "../lib/lock";
import { setPin } from "../lib/pin";
import { isPlatformAuthenticatorAvailable, registerBiometric } from "../lib/webauthn";

function PinForm({ onSaved }: { onSaved: () => void }) {
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState<string>();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pin1.length < 4) return setError("PIN must be at least 4 digits.");
    if (pin1 !== pin2) return setError("PINs don't match.");
    await setPin(pin1);
    onSaved();
  }

  return (
    <form onSubmit={handleSubmit} className="mb-2 space-y-2">
      <input
        type="password"
        inputMode="numeric"
        placeholder="New PIN"
        value={pin1}
        onChange={(e) => setPin1(e.target.value.replace(/\D/g, "").slice(0, 6))}
        className="w-full rounded-xl border border-line bg-paper-raised px-3 py-2 text-center text-sm tracking-widest text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
      />
      <input
        type="password"
        inputMode="numeric"
        placeholder="Confirm PIN"
        value={pin2}
        onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 6))}
        className="w-full rounded-xl border border-line bg-paper-raised px-3 py-2 text-center text-sm tracking-widest text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
      />
      {error && <p className="text-xs text-claude">{error}</p>}
      <button
        type="submit"
        className="w-full rounded-full bg-ink px-4 py-2 text-xs font-medium text-paper dark:bg-ink-dark dark:text-paper-dark"
      >
        Save PIN
      </button>
    </form>
  );
}

function ResetLockControl({ onReset }: { onReset: () => void }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="text-xs text-ink-faint underline dark:text-ink-faint-dark"
      >
        Remove biometric + PIN setup
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <p className="text-xs text-ink-soft dark:text-ink-soft-dark">Turn off App Lock and remove setup?</p>
      <button
        onClick={() => {
          resetLock();
          setConfirming(false);
          onReset();
        }}
        className="text-xs font-medium text-claude"
      >
        Remove
      </button>
      <button onClick={() => setConfirming(false)} className="text-xs text-ink-faint dark:text-ink-faint-dark">
        Cancel
      </button>
    </div>
  );
}

export function AppLockSettings() {
  const [status, setStatus] = useState(lockStatus());
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricError, setBiometricError] = useState<string>();
  const [showPinForm, setShowPinForm] = useState(false);

  useEffect(() => {
    isPlatformAuthenticatorAvailable().then(setBiometricAvailable);
  }, []);

  function refresh() {
    setStatus(lockStatus());
    setShowPinForm(false);
  }

  async function handleRegisterBiometric() {
    setBiometricBusy(true);
    setBiometricError(undefined);
    try {
      await registerBiometric();
      refresh();
    } catch {
      setBiometricError("Couldn't set up biometric unlock. You can still use a PIN.");
    } finally {
      setBiometricBusy(false);
    }
  }

  function handleTurnOn() {
    if (!canEnableLock()) return setShowPinForm(true);
    setLockEnabled(true);
    refresh();
  }

  function handleTurnOff() {
    setLockEnabled(false);
    refresh();
  }

  if (status.enabled) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-xl border border-line px-4 py-3 dark:border-line-dark">
          <div>
            <p className="text-sm text-ink dark:text-ink-dark">App Lock is on</p>
            <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
              {status.biometricRegistered ? "Biometric + PIN fallback" : "PIN only"}
            </p>
          </div>
          <button
            onClick={handleTurnOff}
            className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-soft dark:border-line-dark dark:text-ink-soft-dark"
          >
            Turn off
          </button>
        </div>
        <ResetLockControl onReset={refresh} />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
      <p className="mb-3 text-sm text-ink-soft dark:text-ink-soft-dark">
        Require unlock to open Alfred — worth it now that it holds email, calendar, and client details.
      </p>

      {biometricAvailable && !status.biometricRegistered && (
        <button
          onClick={handleRegisterBiometric}
          disabled={biometricBusy}
          className="mb-2 w-full rounded-full bg-ink px-4 py-2 text-xs font-medium text-paper disabled:opacity-60 dark:bg-ink-dark dark:text-paper-dark"
        >
          {biometricBusy ? "Setting up…" : "Set up biometric unlock"}
        </button>
      )}
      {status.biometricRegistered && (
        <p className="mb-2 text-xs text-ink-faint dark:text-ink-faint-dark">Biometric unlock ready.</p>
      )}
      {biometricAvailable === false && (
        <p className="mb-2 text-xs text-ink-faint dark:text-ink-faint-dark">
          Biometric unlock isn't available on this device — PIN only.
        </p>
      )}
      {biometricError && <p className="mb-2 text-xs text-claude">{biometricError}</p>}

      {showPinForm && <PinForm onSaved={refresh} />}

      {status.pinSet && !showPinForm && (
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs text-ink-faint dark:text-ink-faint-dark">Backup PIN set.</p>
          <button onClick={() => setShowPinForm(true)} className="text-xs text-ink-faint underline dark:text-ink-faint-dark">
            Change
          </button>
        </div>
      )}
      {!status.pinSet && !showPinForm && (
        <button
          onClick={() => setShowPinForm(true)}
          className="mb-2 w-full rounded-full border border-line px-4 py-2 text-xs font-medium text-ink-soft dark:border-line-dark dark:text-ink-soft-dark"
        >
          Set a backup PIN
        </button>
      )}

      {status.pinSet && !showPinForm && (
        <button
          onClick={handleTurnOn}
          className="w-full rounded-full bg-ink px-4 py-2 text-xs font-medium text-paper dark:bg-ink-dark dark:text-paper-dark"
        >
          Turn on App Lock
        </button>
      )}
    </div>
  );
}

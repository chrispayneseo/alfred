import { useEffect, useState } from "react";
import {
  CONNECT_ANOTHER_ACCOUNT_URL,
  disconnectGoogleAccount,
  fetchGoogleAccounts,
  reconnectGoogleAccountUrl,
  type GoogleAccount,
} from "../integrations/google-accounts/api";

export function GoogleAccountsSettings() {
  const [accounts, setAccounts] = useState<GoogleAccount[]>();
  const [error, setError] = useState<string>();
  const [disconnecting, setDisconnecting] = useState<string>();

  useEffect(() => {
    fetchGoogleAccounts()
      .then(setAccounts)
      .catch(() => setError("Couldn't load connected accounts."));
  }, []);

  async function handleDisconnect(email: string) {
    setDisconnecting(email);
    setError(undefined);
    try {
      await disconnectGoogleAccount(email);
      setAccounts((prev) => prev?.filter((a) => a.email !== email));
    } catch {
      setError(`Couldn't disconnect ${email}. Try again.`);
    } finally {
      setDisconnecting(undefined);
    }
  }

  if (!accounts) {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>;
  }

  return (
    <div className="space-y-3">
      {accounts.length === 0 && (
        <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
          No Google accounts connected yet — connect one from the Today screen, or below.
        </p>
      )}

      {accounts.map((account) => (
        <div
          key={account.email}
          className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-3 dark:border-line-dark"
        >
          <div>
            <p className="text-sm text-ink dark:text-ink-dark">{account.email}</p>
            {account.status === "reconnect_required" && <p className="text-xs text-claude">Needs reconnecting</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {account.status === "reconnect_required" && (
              <a
                href={reconnectGoogleAccountUrl(account.email)}
                className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper dark:bg-ink-dark dark:text-paper-dark"
              >
                Reconnect
              </a>
            )}
            <button
              onClick={() => handleDisconnect(account.email)}
              disabled={disconnecting === account.email}
              className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-soft disabled:opacity-60 dark:border-line-dark dark:text-ink-soft-dark"
            >
              {disconnecting === account.email ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </div>
      ))}

      {error && <p className="text-xs text-claude">{error}</p>}

      <a
        href={CONNECT_ANOTHER_ACCOUNT_URL}
        className="inline-block rounded-full border border-line px-4 py-1.5 text-xs font-medium text-ink-soft dark:border-line-dark dark:text-ink-soft-dark"
      >
        {accounts.length === 0 ? "Connect a Google account" : "Connect another Google account"}
      </a>
    </div>
  );
}

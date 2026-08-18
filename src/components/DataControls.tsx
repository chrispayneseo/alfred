import { useState } from "react";
import { fetchExport, wipeEverything } from "../integrations/settings/api";

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ExportControl() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function handleExport() {
    setBusy(true);
    setError(undefined);
    try {
      const data = await fetchExport();
      const date = new Date().toISOString().slice(0, 10);
      downloadJson(data, `alfred-export-${date}.json`);
    } catch {
      setError("Couldn't build the export right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-line px-4 py-3 dark:border-line-dark">
      <p className="mb-2 text-sm text-ink-soft dark:text-ink-soft-dark">
        Download what Alfred caches locally — email metadata, nudge history, and a summary of connected
        integrations and their scopes. Not included: your Notion content (already yours, exportable from
        Notion directly) or any credentials.
      </p>
      <button
        onClick={handleExport}
        disabled={busy}
        className="rounded-full border border-line px-4 py-1.5 text-xs font-medium text-ink-soft disabled:opacity-60 dark:border-line-dark dark:text-ink-soft-dark"
      >
        {busy ? "Preparing…" : "Export my data"}
      </button>
      {error && <p className="mt-2 text-xs text-claude">{error}</p>}
    </div>
  );
}

function WipeControl() {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  async function handleWipe() {
    setBusy(true);
    setError(undefined);
    try {
      await wipeEverything();
      setDone(true);
    } catch {
      setError("Something went wrong — nothing was necessarily disconnected. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
        <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
          Disconnected. Google access was revoked and local caches cleared — Alfred is back to a fresh
          "not connected" state. Your Notion workspace wasn't touched.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
      <p className="mb-2 text-sm text-ink-soft dark:text-ink-soft-dark">
        Revokes Google access (Calendar + Gmail) and clears everything Alfred caches locally. Your Notion
        workspace and its content are never touched. This can't be undone.
      </p>
      <p className="mb-2 text-xs text-ink-faint dark:text-ink-faint-dark">
        Type <span className="font-medium text-ink dark:text-ink-dark">delete</span> to confirm.
      </p>
      <input
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder="delete"
        className="mb-2 w-full rounded-xl border border-line bg-paper-raised px-3 py-2 text-sm text-ink dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
      />
      <button
        onClick={handleWipe}
        disabled={busy || confirmText.trim().toLowerCase() !== "delete"}
        className="w-full rounded-full bg-claude px-4 py-2 text-xs font-medium text-paper disabled:opacity-40"
      >
        {busy ? "Disconnecting…" : "Delete everything / disconnect"}
      </button>
      {error && <p className="mt-2 text-xs text-claude">{error}</p>}
    </div>
  );
}

/** Export/wipe only — "What Alfred can do" moved to its own Privacy
 * section (see PermissionsTrust), grouped separately in Settings. */
export function DataControls() {
  return (
    <div>
      <ExportControl />
      <WipeControl />
    </div>
  );
}

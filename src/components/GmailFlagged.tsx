import { useEffect, useRef, useState } from "react";
import {
  dismissFlaggedEmail,
  fetchFlaggedEmails,
  fetchGmailScanStatus,
  fetchGmailStatus,
  fetchGmailSyncStatus,
  startGmailScan,
  startGmailSync,
  type FlaggedEmail,
  type GmailStatus,
  type ScanStatus,
  type SyncStatus,
} from "../integrations/gmail/api";
import { fetchGoogleAccounts, type GoogleAccount } from "../integrations/google-accounts/api";
import { buildAccountColorMap } from "../lib/accountColor";
import { AccountTag } from "./AccountTag";

type PanelState = "loading" | "not_connected" | "ready" | "error";

const SYNC_DAYS = 30;
const SCAN_BATCH_SIZE = 50;
const POLL_MS = 1000;

function gmailThreadUrl(threadId: string, accountEmail: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(accountEmail)}/#inbox/${threadId}`;
}

function formatEmailDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ProgressBar({ processed, total }: { processed: number; total?: number }) {
  const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : undefined;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line dark:bg-line-dark">
      <div
        className="h-full rounded-full bg-ink transition-all dark:bg-ink-dark"
        style={{ width: pct !== undefined ? `${pct}%` : "40%" }}
      />
    </div>
  );
}

function FlaggedItem({
  email,
  colorMap,
  showAccountTag,
  onDismiss,
}: {
  email: FlaggedEmail;
  colorMap: ReturnType<typeof buildAccountColorMap>;
  showAccountTag: boolean;
  onDismiss: (email: FlaggedEmail) => void;
}) {
  const reasons = [
    email.needsReply ? "Reply needed" : undefined,
    email.hasDeadline ? `Deadline${email.deadlineDate ? ` · ${email.deadlineDate}` : ""}` : undefined,
  ].filter(Boolean);

  return (
    <li className="border-b border-line pb-3 last:border-0 dark:border-line-dark">
      <div className="flex items-baseline justify-between gap-2">
        <a
          href={gmailThreadUrl(email.threadId, email.accountEmail)}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-ink hover:underline dark:text-ink-dark"
        >
          {email.subject}
        </a>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-ink-faint dark:text-ink-faint-dark">{formatEmailDate(email.date)}</span>
          <button
            onClick={() => onDismiss(email)}
            aria-label="Remove from flagged"
            className="flex h-4 w-4 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:text-claude dark:text-ink-faint-dark/60"
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      </div>
      <p className="text-xs text-ink-faint dark:text-ink-faint-dark">{email.sender}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-soft dark:text-ink-soft-dark">
        {reasons.map((reason) => (
          <span key={reason}>{reason}</span>
        ))}
        {email.project && <span>Filed · {email.project}</span>}
        {email.draftId && <span>Draft ready in Gmail</span>}
        {showAccountTag && <AccountTag email={email.accountEmail} color={colorMap.get(email.accountEmail) ?? "a"} />}
      </div>
    </li>
  );
}

export function GmailFlagged() {
  const [state, setState] = useState<PanelState>("loading");
  const [status, setStatus] = useState<GmailStatus>();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>();
  const [scanStatus, setScanStatus] = useState<ScanStatus>();
  const [flagged, setFlagged] = useState<FlaggedEmail[]>([]);
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [actionError, setActionError] = useState<string>();
  const pollRef = useRef<number | undefined>(undefined);

  async function refresh() {
    try {
      const [s, accts] = await Promise.all([fetchGmailStatus(), fetchGoogleAccounts()]);
      setStatus(s);
      setAccounts(accts);
      setState(s.connected ? "ready" : "not_connected");
      setFlagged(s.flaggedCount > 0 ? await fetchFlaggedEmails() : []);
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    refresh();
    return () => window.clearInterval(pollRef.current);
  }, []);

  function pollUntilDone<T extends { running: boolean }>(fetchStatus: () => Promise<T>, onUpdate: (s: T) => void) {
    window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      const s = await fetchStatus();
      onUpdate(s);
      if (!s.running) {
        window.clearInterval(pollRef.current);
        await refresh();
      }
    }, POLL_MS);
  }

  async function handleSync() {
    setActionError(undefined);
    try {
      const s = await startGmailSync(SYNC_DAYS);
      setSyncStatus(s);
      pollUntilDone(fetchGmailSyncStatus, setSyncStatus);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Couldn't start sync.");
    }
  }

  async function handleScan() {
    setActionError(undefined);
    try {
      const s = await startGmailScan(SCAN_BATCH_SIZE);
      setScanStatus(s);
      pollUntilDone(fetchGmailScanStatus, setScanStatus);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Couldn't start scan.");
    }
  }

  async function handleDismiss(email: FlaggedEmail) {
    const prev = flagged;
    setFlagged((f) => f.filter((e) => !(e.accountEmail === email.accountEmail && e.id === email.id)));
    try {
      await dismissFlaggedEmail(email.accountEmail, email.id);
    } catch {
      setFlagged(prev);
    }
  }

  if (state === "loading") {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>;
  }

  if (state === "not_connected") {
    return (
      <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
        <p className="mb-2 text-sm text-ink-soft dark:text-ink-soft-dark">
          Connect Gmail to flag emails needing action and file them into Notion.
        </p>
        <a
          href="/api/google/auth/start"
          className="inline-block rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-paper dark:bg-ink-dark dark:text-paper-dark"
        >
          Connect Gmail
        </a>
      </div>
    );
  }

  if (state === "error" || !status) {
    return <p className="text-sm text-claude">Couldn't load Gmail right now. Try again shortly.</p>;
  }

  const jobError = syncStatus?.error ?? scanStatus?.error;
  const needsReconnect = jobError === "reconnect_required";
  const apiDisabled = jobError === "api_disabled";
  const accountColorMap = buildAccountColorMap(accounts);
  const showAccountTags = accounts.length > 1;

  return (
    <div>
      {needsReconnect && (
        <div className="mb-3 rounded-xl border border-line px-4 py-3 dark:border-line-dark">
          <p className="mb-2 text-sm text-ink-soft dark:text-ink-soft-dark">Gmail access needs to be reconnected.</p>
          <a
            href="/api/google/auth/start"
            className="inline-block rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-paper dark:bg-ink-dark dark:text-paper-dark"
          >
            Reconnect Gmail
          </a>
        </div>
      )}

      {apiDisabled && (
        <div className="mb-3 rounded-xl border border-line px-4 py-3 dark:border-line-dark">
          <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
            The Gmail API isn't enabled for this Google Cloud project yet. Enable it at{" "}
            <a
              href="https://console.cloud.google.com/apis/library/gmail.googleapis.com"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              console.cloud.google.com
            </a>
            , then try again — no need to reconnect.
          </p>
        </div>
      )}

      {actionError && <p className="mb-2 text-xs text-claude">{actionError}</p>}

      {syncStatus?.running && (
        <div className="mb-3">
          <p className="mb-1.5 text-xs text-ink-soft dark:text-ink-soft-dark">
            Syncing inbox… {syncStatus.processed}
            {syncStatus.total ? ` / ${syncStatus.total}` : ""}
          </p>
          <ProgressBar processed={syncStatus.processed} total={syncStatus.total} />
        </div>
      )}

      {scanStatus?.running && (
        <div className="mb-3">
          <p className="mb-1.5 text-xs text-ink-soft dark:text-ink-soft-dark">
            Scanning for action items… {scanStatus.processed} / {scanStatus.total}
          </p>
          <ProgressBar processed={scanStatus.processed} total={scanStatus.total} />
        </div>
      )}

      {!syncStatus?.running && !scanStatus?.running && !needsReconnect && !apiDisabled && (
        <>
          {status.totalEmails === 0 && (
            <div className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
              <p className="mb-2 text-sm text-ink-soft dark:text-ink-soft-dark">
                Sync your inbox to start flagging action items.
              </p>
              <button
                onClick={handleSync}
                className="rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-paper dark:bg-ink-dark dark:text-paper-dark"
              >
                Sync last {SYNC_DAYS} days
              </button>
            </div>
          )}

          {status.totalEmails > 0 && status.unscannedCount > 0 && (
            <div className="mb-3 flex items-center justify-between rounded-xl border border-line px-4 py-3 dark:border-line-dark">
              <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
                {status.unscannedCount} email{status.unscannedCount === 1 ? "" : "s"} ready to scan.
              </p>
              <button
                onClick={handleScan}
                className="shrink-0 rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-paper dark:bg-ink-dark dark:text-paper-dark"
              >
                Scan
              </button>
            </div>
          )}

          {status.totalEmails > 0 && flagged.length === 0 && status.unscannedCount === 0 && (
            <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing flagged right now.</p>
          )}

          {flagged.length > 0 && (
            <ul className="space-y-3">
              {flagged.map((email) => (
                <FlaggedItem
                  key={`${email.accountEmail}:${email.id}`}
                  email={email}
                  colorMap={accountColorMap}
                  showAccountTag={showAccountTags}
                  onDismiss={handleDismiss}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

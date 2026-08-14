import { useEffect, useState } from "react";
import { fetchGoogleAccounts, type GoogleAccount } from "../integrations/google-accounts/api";
import { fetchIntegrationStatus, type IntegrationStatus } from "../integrations/settings/api";

interface PermissionRow {
  name: string;
  detail: string;
  show: boolean;
}

function accountList(accounts: GoogleAccount[]): string {
  return accounts.map((a) => a.email).join(", ");
}

/** Purely informational — reads the same connection/scope facts every other
 * part of Settings already reads, just gathered in one calm place. Doesn't
 * change or gate anything itself. */
export function PermissionsTrust() {
  const [status, setStatus] = useState<IntegrationStatus>();
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([fetchIntegrationStatus(), fetchGoogleAccounts()])
      .then(([s, a]) => {
        setStatus(s);
        setAccounts(a);
      })
      .catch(() => setError("Couldn't load integration status right now."));
  }, []);

  if (error) return <p className="text-sm text-claude">{error}</p>;
  if (!status) return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>;

  const hasGoogle = accounts.length > 0;

  const rows: PermissionRow[] = [
    {
      name: "Notion",
      detail:
        "Read + Write. Your workspace is the source of truth — Alfred creates and updates Tasks, Notes, and Inbox items there. It can archive an item when you remove one (recoverable in Notion's own trash for 30 days), but never permanently deletes anything, and never touches other content in your workspace.",
      show: status.notion,
    },
    {
      name: "Google Calendar",
      detail: hasGoogle
        ? `Read on every connected account (${accountList(accounts)}), plus creating events — but only when you explicitly ask in Chat and confirm the exact details Alfred proposes first. Alfred never edits or deletes an event, and never creates one without that confirmation.`
        : "Not connected — connect a Google account to enable this.",
      show: true,
    },
    {
      name: "Gmail",
      detail: hasGoogle
        ? `Read + Draft only, on every connected account (${accountList(accounts)}). Alfred can read your inbox and create drafts for your review. It can never send an email on your behalf.`
        : "Not connected — connect a Google account to enable this.",
      show: true,
    },
    {
      name: "CoachPlan",
      detail:
        "Read-only, scoped to one team's upcoming training sessions and matches. Alfred never writes back to CoachPlan.",
      show: status.coachplan,
    },
    {
      name: "Claude (Anthropic)",
      detail:
        "Alfred sends your message and whatever relevant context it gathered (Notion, calendar, email) to Claude's API to generate a reply. Anthropic doesn't have standing access to your accounts — only what's included in that one request.",
      show: status.anthropic,
    },
    {
      name: "ChatGPT (OpenAI)",
      detail:
        "Same as Claude, for requests Alfred routes to ChatGPT instead — only the content of that one request is shared, nothing standing.",
      show: status.openai,
    },
    {
      name: "ntfy",
      detail:
        "Alfred sends nudge and digest text to your chosen ntfy topic so it can reach your phone as a push notification. ntfy topics aren't private unless you've added your own authentication — anyone who knows the topic name can read what's sent there.",
      show: status.ntfy,
    },
  ];

  return (
    <div className="space-y-3">
      {rows
        .filter((r) => r.show)
        .map((row) => (
          <div key={row.name} className="rounded-xl border border-line px-4 py-3 dark:border-line-dark">
            <p className="text-sm font-medium text-ink dark:text-ink-dark">{row.name}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft dark:text-ink-soft-dark">{row.detail}</p>
          </div>
        ))}
    </div>
  );
}

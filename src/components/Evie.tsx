import { useEffect, useState } from "react";
import { createCalendarEvent } from "../integrations/google-calendar/api";
import {
  acceptEvieProposal,
  dismissEvieProposal,
  fetchEvieActionItems,
  fetchEvieProposals,
  resolveEvieActionItem,
  type EvieActionItem,
  type EvieProposal,
} from "../integrations/evie/api";

type PanelState = "loading" | "ready" | "error";

// Same deep-link shape as GmailFlagged.tsx (duplicated locally there too,
// rather than shared — see that file).
function gmailThreadUrl(threadId: string, accountEmail: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(accountEmail)}/#inbox/${threadId}`;
}

function formatProposal(p: EvieProposal): string {
  const date = new Date(`${p.date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (!p.startTime) return date;
  return `${date}, ${p.startTime}${p.endTime ? `–${p.endTime}` : ""}`;
}

function ProposalCard({
  proposal,
  onResolved,
}: {
  proposal: EvieProposal;
  onResolved: (id: string) => void;
}) {
  const [status, setStatus] = useState<"pending" | "submitting" | "error">("pending");
  const [error, setError] = useState<string>();

  async function handleAdd() {
    setStatus("submitting");
    setError(undefined);
    try {
      await createCalendarEvent({
        title: proposal.title,
        date: proposal.date,
        startTime: proposal.startTime,
        endTime: proposal.endTime,
        account: proposal.accountEmail,
      });
      await acceptEvieProposal(proposal.id);
      onResolved(proposal.id);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't add that event.");
    }
  }

  async function handleCancel() {
    setStatus("submitting");
    try {
      await dismissEvieProposal(proposal.id);
      onResolved(proposal.id);
    } catch {
      setStatus("pending");
    }
  }

  return (
    <li className="rounded-2xl border border-line px-4 py-3 dark:border-line-dark">
      <p className="text-sm text-ink dark:text-ink-dark">{proposal.title}</p>
      <p className="mt-0.5 text-xs text-ink-faint dark:text-ink-faint-dark">
        {formatProposal(proposal)}
        {proposal.location ? ` · ${proposal.location}` : ""}
      </p>
      <a
        href={gmailThreadUrl(proposal.threadId, proposal.accountEmail)}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-block text-[11px] text-ink-faint underline dark:text-ink-faint-dark"
      >
        View email
      </a>

      {status === "error" && <p className="mt-2 text-xs text-claude">{error}</p>}

      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={handleAdd}
          disabled={status === "submitting"}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
        >
          {status === "submitting" ? "Adding…" : "Add to calendar"}
        </button>
        <button
          onClick={handleCancel}
          disabled={status === "submitting"}
          className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
        >
          Cancel
        </button>
      </div>
    </li>
  );
}

function ActionItemRow({ item, onDone }: { item: EvieActionItem; onDone: (id: string) => void }) {
  const [submitting, setSubmitting] = useState(false);

  async function handleDone() {
    setSubmitting(true);
    try {
      await resolveEvieActionItem(item.id);
      onDone(item.id);
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <li className="border-b border-line pb-3 last:border-0 dark:border-line-dark">
      <div className="flex items-baseline justify-between gap-2">
        <a
          href={gmailThreadUrl(item.threadId, item.accountEmail)}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-ink hover:underline dark:text-ink-dark"
        >
          {item.subject}
        </a>
        <button
          onClick={handleDone}
          disabled={submitting}
          className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-[11px] font-medium text-ink-soft disabled:opacity-50 dark:border-line-dark dark:text-ink-soft-dark"
        >
          Done
        </button>
      </div>
      <p className="text-xs text-ink-faint dark:text-ink-faint-dark">{item.summary}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-soft dark:text-ink-soft-dark">
        <span>{item.reason}</span>
        {item.dueDate && <span>Due {item.dueDate}</span>}
      </div>
    </li>
  );
}

export function Evie() {
  const [state, setState] = useState<PanelState>("loading");
  const [proposals, setProposals] = useState<EvieProposal[]>([]);
  const [actionItems, setActionItems] = useState<EvieActionItem[]>([]);

  useEffect(() => {
    Promise.all([fetchEvieProposals(), fetchEvieActionItems()])
      .then(([p, a]) => {
        setProposals(p);
        setActionItems(a);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  if (state === "loading") {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>;
  }
  if (state === "error") {
    return <p className="text-sm text-claude">Couldn't load Evie right now. Try again shortly.</p>;
  }
  if (proposals.length === 0 && actionItems.length === 0) {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing from Evie right now.</p>;
  }

  return (
    <div className="flex flex-col gap-5">
      {proposals.length > 0 && (
        <ul className="flex flex-col gap-3">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onResolved={(id) => setProposals((prev) => prev.filter((x) => x.id !== id))} />
          ))}
        </ul>
      )}
      {actionItems.length > 0 && (
        <ul className="space-y-3">
          {actionItems.map((item) => (
            <ActionItemRow key={item.id} item={item} onDone={(id) => setActionItems((prev) => prev.filter((x) => x.id !== id))} />
          ))}
        </ul>
      )}
    </div>
  );
}

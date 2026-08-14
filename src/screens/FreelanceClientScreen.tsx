import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Screen } from "../components/Screen";
import { fetchClientView, type ClientEmail, type ClientTask, type ClientView } from "../integrations/freelance/api";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function gmailThreadUrl(threadId: string, accountEmail: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(accountEmail)}/#inbox/${threadId}`;
}

function upcomingDeadlines(tasks: ClientTask[]): ClientTask[] {
  return tasks
    .filter((t) => !t.done && t.due)
    .sort((a, b) => (a.due! < b.due! ? -1 : 1));
}

export function FreelanceClientScreen() {
  const { client: clientParam } = useParams<{ client: string }>();
  const client = clientParam ? decodeURIComponent(clientParam) : "";
  const [view, setView] = useState<ClientView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!client) return;
    setView(undefined);
    setError(undefined);
    fetchClientView(client)
      .then(setView)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load this client."));
  }, [client]);

  const deadlines = view ? upcomingDeadlines(view.tasks) : [];

  return (
    <Screen
      title={client}
      subtitle="Freelance client"
      headerAction={
        <Link
          to="/freelance"
          className="mt-1 rounded-full p-1.5 text-ink-faint hover:text-ink dark:text-ink-faint-dark dark:hover:text-ink-dark"
          aria-label="Back to clients"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      }
    >
      {error && <p className="text-sm text-claude">{error}</p>}
      {!error && !view && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>}

      {view && (
        <>
          <section className="mb-8">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
              Upcoming deadlines
            </h2>
            {deadlines.length === 0 && (
              <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing with a due date.</p>
            )}
            <ul className="space-y-2.5">
              {deadlines.map((task) => (
                <li key={task.id} className="flex items-baseline justify-between gap-3">
                  <p className="text-sm text-ink dark:text-ink-dark">{task.title}</p>
                  <span className="shrink-0 text-xs text-ink-faint dark:text-ink-faint-dark">{formatDate(task.due!)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
              Notes
            </h2>
            {view.notes.length === 0 && (
              <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing tagged to this client yet.</p>
            )}
            <ul className="space-y-3">
              {view.notes.map((note) => (
                <li key={note.id}>
                  <p className="text-sm text-ink dark:text-ink-dark">{note.title}</p>
                  <p className="mt-0.5 text-[11px] text-ink-faint/80 dark:text-ink-faint-dark/80">{formatDate(note.updatedAt)}</p>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
              Related email
            </h2>
            {view.emails.length === 0 && (
              <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing matched in your synced inbox.</p>
            )}
            <ul className="space-y-3">
              {view.emails.map((email) => (
                <EmailItem key={`${email.accountEmail}:${email.id}`} email={email} />
              ))}
            </ul>
          </section>
        </>
      )}
    </Screen>
  );
}

function EmailItem({ email }: { email: ClientEmail }) {
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
        <span className="shrink-0 text-[11px] text-ink-faint dark:text-ink-faint-dark">{formatDate(email.date)}</span>
      </div>
      <p className="text-xs text-ink-faint dark:text-ink-faint-dark">{email.sender}</p>
    </li>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Screen } from "../components/Screen";
import { fetchFreelanceClients, type ClientSummary } from "../integrations/freelance/api";

export function FreelanceScreen() {
  const [clients, setClients] = useState<ClientSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchFreelanceClients()
      .then(setClients)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load clients."));
  }, []);

  return (
    <Screen title="Freelance clients" subtitle="Notes, tasks, and email in one place per client">
      {error && <p className="text-sm text-claude">{error}</p>}
      {!error && !clients && <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Loading…</p>}

      {clients && (
        <ul className="space-y-3">
          {clients.map((client) => (
            <li key={client.name}>
              <Link
                to={`/freelance/${encodeURIComponent(client.name)}`}
                className="block rounded-2xl border border-line px-4 py-3.5 transition-colors hover:border-ink-faint dark:border-line-dark dark:hover:border-ink-faint-dark"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-ink dark:text-ink-dark">{client.name}</p>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-ink-faint dark:text-ink-faint-dark">
                    <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="mt-1 text-xs text-ink-faint dark:text-ink-faint-dark">
                  {client.openTaskCount} open task{client.openTaskCount === 1 ? "" : "s"} · {client.noteCount} note
                  {client.noteCount === 1 ? "" : "s"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}

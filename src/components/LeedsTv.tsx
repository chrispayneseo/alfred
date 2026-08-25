import { useEffect, useState } from "react";
import { checkLeedsTvFixtures, type TvFixture } from "../integrations/leedsTv/api";

function formatKickoff(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

/** Tile content for the "On TV" section — the next few Leeds fixtures
 * confirmed for UK TV broadcast, nearest first. Same check-on-mount shape
 * as LeedsTickets, but read-only: there's nothing to accept/reject/dismiss
 * here, just a list that refreshes itself in the background. */
export function LeedsTv() {
  const [fixtures, setFixtures] = useState<TvFixture[]>();

  useEffect(() => {
    checkLeedsTvFixtures()
      .then(setFixtures)
      .catch(() => setFixtures([]));
  }, []);

  if (!fixtures) return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">Checking…</p>;

  if (fixtures.length === 0) {
    return <p className="text-sm text-ink-faint dark:text-ink-faint-dark">No fixtures currently confirmed for TV.</p>;
  }

  return (
    <ul className="space-y-2">
      {fixtures.map((f) => (
        <li key={`${f.opponent}|${f.homeAway}|${f.kickoffAt}`} className="rounded-xl border border-line px-3.5 py-2.5 dark:border-line-dark">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-sm text-ink dark:text-ink-dark">
              {f.opponent} ({f.homeAway})
            </p>
            <p className="shrink-0 text-xs font-medium text-ink-soft dark:text-ink-soft-dark">{f.channel}</p>
          </div>
          <p className="truncate text-xs text-ink-faint dark:text-ink-faint-dark">
            {formatKickoff(f.kickoffAt)} · {f.competition}
          </p>
        </li>
      ))}
    </ul>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchWeeklyDigest, isDigestReady, type WeeklyDigest } from "../integrations/digest/api";

function firstLine(summary: string): string {
  const first = summary.split("\n\n")[0];
  return first.length > 140 ? `${first.slice(0, 140).trimEnd()}…` : first;
}

/** Silent when the digest isn't ready yet — this doubles as the
 * check-on-open trigger (same pattern as Nudges), but showing "not due
 * yet" noise on Today every day would work against the calm/minimal
 * design, so it only renders once there's something to show. */
export function WeeklyDigestTeaser() {
  const [digest, setDigest] = useState<WeeklyDigest>();

  useEffect(() => {
    fetchWeeklyDigest()
      .then(setDigest)
      .catch(() => undefined);
  }, []);

  if (!digest || !isDigestReady(digest)) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
        This week
      </h2>
      <Link to="/digest" className="block rounded-2xl border border-line px-4 py-3.5 dark:border-line-dark">
        <p className="text-sm text-ink dark:text-ink-dark">{firstLine(digest.summary)}</p>
        <p className="mt-1.5 text-xs text-ink-faint dark:text-ink-faint-dark">Read the full digest →</p>
      </Link>
    </section>
  );
}

import { useEffect, useState } from "react";
import { fetchCoachPlanUpcoming, type CoachPlanMatch, type CoachPlanSession } from "../integrations/coachplan/api";

type State = "loading" | "ready" | "unconfigured" | "error";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Read-only cross-reference into CoachPlan (a separate coaching app) —
 * silent when unconfigured, when there's genuinely nothing upcoming, or on
 * a fetch error, since this is supplementary data layered onto Today, not
 * a core section that should ever demand attention with an error state. */
export function CoachPlanTeaser() {
  const [state, setState] = useState<State>("loading");
  const [sessions, setSessions] = useState<CoachPlanSession[]>([]);
  const [matches, setMatches] = useState<CoachPlanMatch[]>([]);

  useEffect(() => {
    fetchCoachPlanUpcoming()
      .then((data) => {
        if (!data.configured) {
          setState("unconfigured");
          return;
        }
        setSessions(data.sessions);
        setMatches(data.matches);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  if (state !== "ready" || (sessions.length === 0 && matches.length === 0)) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
        Football Coaching
      </h2>
      <div className="space-y-3">
        {sessions.length > 0 && (
          <div>
            <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint/80 dark:text-ink-faint-dark/80">
              Next training
            </h3>
            <p className="text-sm text-ink dark:text-ink-dark">{formatDate(sessions[0].date)}</p>
          </div>
        )}
        {matches.length > 0 && (
          <div>
            <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint/80 dark:text-ink-faint-dark/80">
              Next match
            </h3>
            <p className="text-sm text-ink dark:text-ink-dark">
              {formatDate(matches[0].date)}
              {matches[0].opponent ? ` vs ${matches[0].opponent}` : ""}
            </p>
            {matches[0].location && (
              <p className="text-xs text-ink-faint dark:text-ink-faint-dark">{matches[0].location}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

import { getUpcomingMatches, getUpcomingSessions } from "../coachplan/coachplan.js";
import type { CoachPlanEnv } from "../coachplan/env.js";
import { isCoachPlanConfigured } from "../coachplan/env.js";

const COACHPLAN_KEYWORDS = ["training", "session", "coaching", "match", "fixture", "opponent", "lionesses", "team"];

/** Keyword heuristic — same approach as needsCalendarContext/needsEmailContext. */
export function needsCoachPlanContext(text: string): boolean {
  const lower = text.toLowerCase();
  return COACHPLAN_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** Never throws — an unconfigured integration or a query failure becomes an
 * honest note in the context, same pattern as calendarContext.ts. */
export async function buildCoachPlanContext(env: CoachPlanEnv): Promise<string> {
  if (!isCoachPlanConfigured(env)) {
    return "CoachPlan (the separate coaching app) isn't connected — Football Coaching session/match info, if any, lives only in Notion.";
  }

  try {
    const [sessions, matches] = await Promise.all([getUpcomingSessions(env), getUpcomingMatches(env)]);
    const sessionsBlock = sessions.length
      ? sessions.map((s) => `- ${s.date}${s.notes ? ` — ${s.notes}` : ""}`).join("\n")
      : "No upcoming training sessions scheduled.";
    const matchesBlock = matches.length
      ? matches
          .map((m) => {
            const time = m.time ? ` at ${m.time}` : "";
            const opponent = m.opponent ? ` vs ${m.opponent}` : "";
            const location = m.location ? ` — ${m.location}` : "";
            return `- ${m.date}${time}${opponent}${location}`;
          })
          .join("\n")
      : "No upcoming matches scheduled.";

    return `Here is real data read directly from CoachPlan (the user's separate coaching app) for their team, Football Coaching — use it to answer precisely, don't guess.\n\nUpcoming training sessions:\n${sessionsBlock}\n\nUpcoming matches:\n${matchesBlock}`;
  } catch (error) {
    console.error("[coachPlanContext] failed to fetch CoachPlan data:", error);
    return "CoachPlan data couldn't be fetched right now due to an error. If asked about training or matches, say so rather than guessing.";
  }
}

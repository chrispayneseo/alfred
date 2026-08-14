export interface CoachPlanEnv {
  url: string;
  key: string;
  teamId: string;
}

/** Takes a raw env source rather than loading one itself — see
 * google/env.ts for why (dev uses Vite's loadEnv(), prod uses process.env).
 * All three empty means the integration is simply unconfigured — every
 * caller treats that as "skip CoachPlan," not an error. */
export function loadCoachPlanEnv(source: Record<string, string | undefined>): CoachPlanEnv {
  return {
    url: source.COACHPLAN_SUPABASE_URL ?? "",
    key: source.COACHPLAN_SUPABASE_KEY ?? "",
    teamId: source.COACHPLAN_TEAM_ID ?? "",
  };
}

export function isCoachPlanConfigured(env: CoachPlanEnv): boolean {
  return Boolean(env.url && env.key && env.teamId);
}

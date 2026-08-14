// Read-only cross-reference into CoachPlan's Supabase database — one
// direction only (Alfred never writes here). Every query is scoped to
// COACHPLAN_TEAM_ID; nothing else in that database is ever touched.
import { getCoachPlanClient } from "./client.js";
import type { CoachPlanEnv } from "./env.js";

export interface UpcomingSession {
  id: string;
  date: string;
  notes?: string;
}

export interface UpcomingMatch {
  id: string;
  date: string;
  opponent?: string;
  location?: string;
  time?: string;
  arrivalTime?: string;
  address?: string;
  venueNotes?: string;
  matchType?: string;
  status?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseRow = Record<string, any>;

// `date` is stored as free-form text on both tables, not a real date/
// timestamp column — sorting/filtering "upcoming" via a SQL WHERE clause
// would silently misbehave if the format isn't zero-padded ISO. Parsing in
// JS after fetching is slower but correct regardless of the stored format,
// and a row that fails to parse is just skipped rather than breaking the
// whole list.
function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function upcomingSorted(rows: SupabaseRow[]): SupabaseRow[] {
  const now = Date.now();
  return rows
    .map((row) => ({ row, parsed: parseDate(row.date) }))
    .filter((r): r is { row: SupabaseRow; parsed: Date } => r.parsed !== undefined && r.parsed.getTime() >= now)
    .sort((a, b) => a.parsed.getTime() - b.parsed.getTime())
    .map(({ row }) => row);
}

export async function getUpcomingSessions(env: CoachPlanEnv, limit = 5): Promise<UpcomingSession[]> {
  const client = getCoachPlanClient(env);
  const { data, error } = await client.from("training_sessions").select("id, date, notes").eq("team_id", env.teamId);
  if (error) throw new Error(`CoachPlan training_sessions query failed: ${error.message}`);

  return upcomingSorted(data ?? [])
    .slice(0, limit)
    .map((row) => ({ id: row.id, date: row.date, notes: row.notes ?? undefined }));
}

export async function getUpcomingMatches(env: CoachPlanEnv, limit = 5): Promise<UpcomingMatch[]> {
  const client = getCoachPlanClient(env);
  const { data, error } = await client
    .from("matches")
    .select("id, date, opponent, location, time, arrival_time, address, venue_notes, match_type, status")
    .eq("team_id", env.teamId);
  if (error) throw new Error(`CoachPlan matches query failed: ${error.message}`);

  return upcomingSorted(data ?? [])
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      date: row.date,
      opponent: row.opponent ?? undefined,
      location: row.location ?? undefined,
      time: row.time ?? undefined,
      arrivalTime: row.arrival_time ?? undefined,
      address: row.address ?? undefined,
      venueNotes: row.venue_notes ?? undefined,
      matchType: row.match_type ?? undefined,
      status: row.status ?? undefined,
    }));
}

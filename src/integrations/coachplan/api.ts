export interface CoachPlanSession {
  id: string;
  date: string;
  notes?: string;
}

export interface CoachPlanMatch {
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

export interface CoachPlanUpcoming {
  configured: boolean;
  sessions: CoachPlanSession[];
  matches: CoachPlanMatch[];
}

export async function fetchCoachPlanUpcoming(): Promise<CoachPlanUpcoming> {
  const res = await fetch("/api/coachplan/upcoming");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

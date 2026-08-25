export interface TvFixture {
  opponent: string;
  homeAway: "H" | "A";
  competition: string;
  channel: string;
  kickoffAt: string;
}

export async function checkLeedsTvFixtures(): Promise<TvFixture[]> {
  const res = await fetch("/api/leeds-tv");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

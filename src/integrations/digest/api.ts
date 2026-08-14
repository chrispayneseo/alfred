export interface WeeklyDigestReady {
  weekKey: string;
  summary: string;
  generatedAt: string;
  isFresh: boolean;
}

export interface WeeklyDigestNotReady {
  available: false;
  triggerDay: "sunday" | "monday";
}

export type WeeklyDigest = WeeklyDigestReady | WeeklyDigestNotReady;

export function isDigestReady(digest: WeeklyDigest): digest is WeeklyDigestReady {
  return !("available" in digest);
}

export async function fetchWeeklyDigest(): Promise<WeeklyDigest> {
  const res = await fetch("/api/digest/weekly");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function generateWeeklyDigestNow(): Promise<WeeklyDigestReady> {
  const res = await fetch("/api/digest/weekly/generate", { method: "POST" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function fetchDigestTriggerDay(): Promise<"sunday" | "monday"> {
  const res = await fetch("/api/digest/weekly/settings");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const { triggerDay } = await res.json();
  return triggerDay;
}

export async function setDigestTriggerDay(day: "sunday" | "monday"): Promise<void> {
  const res = await fetch("/api/digest/weekly/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ triggerDay: day }),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

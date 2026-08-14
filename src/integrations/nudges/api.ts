export interface Nudge {
  taskId: string;
  title: string;
  due?: string;
  projectName?: string;
  message: string;
  pushed: boolean;
}

export async function checkNudges(): Promise<Nudge[]> {
  const res = await fetch("/api/nudges/check", { method: "POST" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

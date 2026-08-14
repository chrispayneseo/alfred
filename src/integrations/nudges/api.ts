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

export async function snoozeNudge(taskId: string): Promise<void> {
  const res = await fetch("/api/nudges/snooze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

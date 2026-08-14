export interface ApiTask {
  id: string;
  title: string;
  done: boolean;
  due?: string;
  projectId?: string;
  projectName?: string;
}

export interface ApiNote {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  updatedAt: string;
}

export interface ApiProject {
  id: string;
  name: string;
  status: string;
}

export interface CaptureResult {
  inbox: { id: string; text: string; status: string };
  filed: { kind: "task" | "note"; id: string; project: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return res.json();
}

export function submitCapture(text: string, source: "manual" | "share-target"): Promise<CaptureResult> {
  return request("/api/capture", { method: "POST", body: JSON.stringify({ text, source }) });
}

export function fetchProjects(): Promise<ApiProject[]> {
  return request("/api/projects");
}

export function fetchTasks(projectId?: string): Promise<ApiTask[]> {
  const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  return request(`/api/tasks${qs}`);
}

export function fetchNotes(projectId?: string): Promise<ApiNote[]> {
  const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  return request(`/api/notes${qs}`);
}

export async function updateTaskStatus(taskId: string, done: boolean): Promise<void> {
  await request(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ done }) });
}

export async function deleteTask(taskId: string): Promise<void> {
  await request(`/api/tasks/${taskId}`, { method: "DELETE" });
}

export interface ApiTask {
  id: string;
  title: string;
  done: boolean;
  due?: string;
  projectId?: string;
  projectName?: string;
  /** Set only for a location-triggered reminder — the place name, exactly
   * as described when it was created. */
  locationTrigger?: string;
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

export interface FiledCapture {
  inbox: { id: string; text: string; status: string };
  filed: { kind: "task" | "note"; id: string; project: string };
}

export interface CaptureItem {
  text: string;
  type: "task" | "note";
  project: string;
  /** Set only when this item is a location-triggered reminder — the place
   * name, editable in the review list before filing. */
  locationTrigger?: string;
}

export interface MultiCaptureResult {
  multiple: true;
  items: CaptureItem[];
}

export type CaptureResult = FiledCapture | MultiCaptureResult;

export function isMultiCaptureResult(result: CaptureResult): result is MultiCaptureResult {
  return "multiple" in result && result.multiple === true;
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

export function submitMultiCapture(
  items: CaptureItem[],
  source: "manual" | "share-target"
): Promise<{ results: FiledCapture[] }> {
  return request("/api/capture/multi", { method: "POST", body: JSON.stringify({ items, source }) });
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

export async function deleteNote(noteId: string): Promise<void> {
  await request(`/api/notes/${noteId}`, { method: "DELETE" });
}

export async function deleteProject(projectId: string): Promise<{ reassigned: number }> {
  return request(`/api/projects/${projectId}`, { method: "DELETE" });
}

/** Files a location reminder Chat proposed, only ever called after the
 * user confirms — mirrors createCalendarEvent's trust relationship with
 * its own propose-then-confirm flow. */
export function createLocationReminder(text: string, locationTrigger: string, project: string): Promise<{ id: string }> {
  return request("/api/capture/location-reminder", { method: "POST", body: JSON.stringify({ text, locationTrigger, project }) });
}

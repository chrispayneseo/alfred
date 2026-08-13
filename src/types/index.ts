export type ModelSource = "claude" | "chatgpt";

export interface TaskItem {
  id: string;
  title: string;
  done: boolean;
  due?: string;
  project?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
}

export interface NoteItem {
  id: string;
  title: string;
  excerpt: string;
  updatedAt: string;
}

export interface ProjectItem {
  id: string;
  name: string;
  status: "active" | "paused" | "done";
  taskCount: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  model?: ModelSource;
  createdAt: string;
}

export interface CaptureItem {
  id: string;
  text: string;
  createdAt: string;
  source: "manual" | "share-target";
  sharedUrl?: string;
}

export type ModelSource = "claude" | "chatgpt";

export interface TaskItem {
  id: string;
  title: string;
  done: boolean;
  due?: string;
  project?: string;
}

export interface NoteItem {
  id: string;
  title: string;
  excerpt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  model?: ModelSource;
  note?: string;
  isError?: boolean;
  createdAt: string;
}

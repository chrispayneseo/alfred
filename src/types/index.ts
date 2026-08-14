export type ModelSource = "claude" | "chatgpt";
export type Confidence = "direct" | "inferred";

export interface EventProposal {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  account: string;
}

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

export type EventProposalStatus = "pending" | "created" | "cancelled" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  model?: ModelSource;
  confidence?: Confidence;
  note?: string;
  isError?: boolean;
  createdAt: string;
  eventProposal?: EventProposal;
  eventProposalStatus?: EventProposalStatus;
  eventProposalError?: string;
}

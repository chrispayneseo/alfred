import { UNSORTED_PROJECT } from "./schema.js";

export type CaptureType = "task" | "note";

export interface Classification {
  type: CaptureType;
  project: string;
}

// Rule-based fallback, used when the real model classifier (server/llm/classify.ts)
// is unavailable — keeps captures filing correctly even if Anthropic is down.
const TASK_KEYWORDS = [
  "todo",
  "to do",
  "remind",
  "call",
  "email",
  "buy",
  "book",
  "pay",
  "follow up",
  "followup",
  "deadline",
  "schedule",
  "finish",
  "submit",
  "review",
  "fix",
  "reply",
  "send",
  "order",
];

const PROJECT_KEYWORDS: Record<string, string[]> = {
  Job: ["work", "meeting", "standup", "boss", "office", "colleague", "1:1", "sprint"],
  Freelance: ["client", "invoice", "freelance", "contract", "dan"],
  "Football Coaching": ["football", "training session", "match", "squad", "coaching", "fixture", "team talk"],
  Personal: ["dentist", "doctor", "home", "family", "genealogy", "holiday", "house"],
  "Side Projects": ["side project", "coachplan", "tasklists", "glassdesk", "setlist", "home dashboard"],
};

export function classify(text: string): Classification {
  const lower = text.toLowerCase();
  const type: CaptureType = TASK_KEYWORDS.some((keyword) => lower.includes(keyword)) ? "task" : "note";

  for (const [project, keywords] of Object.entries(PROJECT_KEYWORDS)) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      return { type, project };
    }
  }

  return { type, project: UNSORTED_PROJECT };
}

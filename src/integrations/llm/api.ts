import type { Confidence, EventProposal, LocationReminderProposal, ModelSource, RecipeProposal } from "../../types";

export interface ChatApiTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatApiResult {
  text: string;
  model: ModelSource;
  intendedModel: ModelSource;
  fellBack: boolean;
  confidence: Confidence;
  eventProposal?: EventProposal;
  locationReminderProposal?: LocationReminderProposal;
  recipeProposal?: RecipeProposal;
}

export async function sendChatMessage(messages: ChatApiTurn[], location?: { lat: number; lon: number }): Promise<ChatApiResult> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, location }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.error === "both_unavailable") throw new Error("both_unavailable");
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }

  return res.json();
}

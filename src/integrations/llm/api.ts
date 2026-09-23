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

const LOCAL_GATEWAY = "https://alfred.tailde2d45.ts.net/v1/gateway";
const LOCAL_CHAT = "https://alfred.tailde2d45.ts.net/v1/chat";

export type GatewayResult =
  | { decision: "local"; reply: string; model: string; memories_used: number }
  | { decision: "cloud_ready" | "approval_required"; reason: string; cloud_prompt: string; memory_sent: false };

export async function askLocalGateway(message: string): Promise<GatewayResult> {
  const res = await fetch(LOCAL_GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Local gateway unavailable (${res.status})`);
  return res.json();
}

export async function sendLocalOnly(message: string): Promise<string> {
  const res = await fetch(LOCAL_CHAT, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Local model unavailable (${res.status})`);
  const body = await res.json() as { reply: string };
  return body.reply;
}

export async function sendPlainCloudMessage(prompt: string): Promise<ChatApiResult> {
  const res = await fetch("/api/chat/plain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, approved: true }),
  });
  if (!res.ok) throw new Error(`Cloud specialist unavailable (${res.status})`);
  return res.json();
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

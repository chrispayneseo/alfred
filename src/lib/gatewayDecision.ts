import type { GatewayResult } from "../integrations/llm/api";

export type GatewayPlan =
  | { kind: "local"; reply: string; memoriesUsed: number }
  | { kind: "approval"; reason: string; prompt: string; scope: "prompt_only" | "connected" };

/** The gateway may choose a route, but never gets to compose a cloud payload. */
export function planGatewayDecision(gateway: GatewayResult, userText: string): GatewayPlan {
  switch (gateway.decision) {
    case "local":
      return { kind: "local", reply: gateway.reply, memoriesUsed: gateway.memories_used };
    case "connection_needed":
      return { kind: "approval", reason: gateway.reply, prompt: userText, scope: "connected" };
    case "cloud_ready":
    case "approval_required":
      return { kind: "approval", reason: gateway.reason, prompt: userText, scope: "prompt_only" };
    default:
      throw new Error("The Dell returned an unknown routing decision.");
  }
}

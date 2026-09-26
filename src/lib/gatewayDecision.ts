import type { GatewayResult, RecallSource } from "../integrations/llm/api";

export type GatewayPlan =
  | { kind: "local"; reply: string; memoriesUsed: number; sources?: RecallSource[] }
  | { kind: "approval"; reason: string; prompt: string; scope: "prompt_only" | "connected" }
  | { kind: "tool_approval"; reason: string; approvalId: string; action: string; integration: string };

/** The gateway may choose a route, but never gets to compose a cloud payload. */
export function planGatewayDecision(gateway: GatewayResult, userText: string): GatewayPlan {
  switch (gateway.decision) {
    case "local":
    case "tool":
      return { kind: "local", reply: gateway.reply, memoriesUsed: gateway.memories_used,
        ...(gateway.sources ? { sources: gateway.sources } : {}) };
    case "connection_needed":
      return { kind: "approval", reason: gateway.reply, prompt: userText, scope: "connected" };
    case "cloud_ready":
      return { kind: "approval", reason: gateway.reason, prompt: userText, scope: "prompt_only" };
    case "approval_required":
      return {
        kind: "tool_approval",
        reason: gateway.reason || gateway.reply,
        approvalId: gateway.approval.id,
        action: gateway.tool_action,
        integration: gateway.integration,
      };
    default:
      throw new Error("The Dell returned an unknown routing decision.");
  }
}

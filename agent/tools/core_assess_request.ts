import { defineTool } from "eve/tools";
import { z } from "zod";
import { assessPolicy } from "../lib/policy";
import { alfredRequestSchema, type NormalizedRequest } from "../lib/contracts";

export default defineTool({
  description: "Assess an Alfred request before responding. Returns the Core-owned policy decision and bootstrap capability boundary.",
  inputSchema: alfredRequestSchema,
  outputSchema: z.object({ requestId: z.string(), policy: z.object({ level: z.enum(["read", "safe_write", "reversible", "external", "high_impact"]), decision: z.enum(["auto", "confirm", "deny"]), reason: z.string() }), capabilities: z.array(z.string()) }),
  async execute(input) {
    const request: NormalizedRequest = { ...input, requestId: input.requestId ?? crypto.randomUUID(), timestamp: input.timestamp ?? new Date().toISOString(), trustLevel: "owner" };
    return { requestId: request.requestId, policy: assessPolicy(request), capabilities: ["request_normalization", "policy_assessment", "session_working_memory", "audit_logging"] };
  },
});

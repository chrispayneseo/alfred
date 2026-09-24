import type { NormalizedRequest, PolicyDecision } from "./contracts";

const HIGH_IMPACT = /\b(buy|purchase|pay|transfer|wire|delete|cancel\s+(?:my|the)|sign\b)\b/i;
const EXTERNAL = /\b(send|email|message|book|reserve|submit|publish|post)\b/i;
const REVERSIBLE = /\b(create|add|schedule|turn\s+(?:on|off)|change|update)\b/i;
const SAFE_WRITE = /\b(save|remember|note|task|shopping\s+list)\b/i;

/** Bootstrap policy classifier. It intentionally errs toward confirmation. */
export function assessPolicy(request: NormalizedRequest): PolicyDecision {
  const text = request.message;
  if (request.trustLevel !== "owner") return { level: "read", decision: "deny", reason: "Only the owner may use the bootstrap Core API." };
  if (HIGH_IMPACT.test(text)) return { level: "high_impact", decision: "deny", reason: "High-impact actions are disabled in the bootstrap release." };
  if (EXTERNAL.test(text)) return { level: "external", decision: "confirm", reason: "External actions always require explicit approval." };
  if (REVERSIBLE.test(text)) return { level: "reversible", decision: "confirm", reason: "Reversible changes require explicit approval." };
  if (SAFE_WRITE.test(text)) return { level: "safe_write", decision: "confirm", reason: "Memory and other writes require confirmation during bootstrap." };
  return { level: "read", decision: "auto", reason: "Read-only request from the owner." };
}

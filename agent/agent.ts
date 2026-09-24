import { defineAgent } from "eve";

export default defineAgent({
  // The bootstrap runtime model is replaceable. The Core's policy and routing
  // modules determine when any model may be used.
  model: "spacexai/grok-4.7",
  limits: {
    maxOutputTokensPerSession: 12_000,
    maxTokenCostUsdPerSession: 1,
    sessionTimeoutMs: 24 * 60 * 60 * 1_000,
  },
});

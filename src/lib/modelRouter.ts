import type { ModelSource } from "../types";

const CLAUDE_KEYWORDS = ["code", "debug", "bug", "function", "script", "error", "refactor"];

/**
 * Mock routing: real routing will weigh cost/latency/task type once the
 * Anthropic and OpenAI clients are wired in. For now this just proves the
 * "every response is tagged with the model that produced it" UX.
 */
export function routeToModel(message: string): ModelSource {
  const lower = message.toLowerCase();
  return CLAUDE_KEYWORDS.some((keyword) => lower.includes(keyword)) ? "claude" : "chatgpt";
}

import { claudeComplete } from "./anthropic";
import type { LlmEnv } from "./env";
import { chatGptComplete } from "./openai";
import { routeToModel, type ModelChoice } from "./router";

async function callModel(
  model: ModelChoice,
  env: LlmEnv,
  systemPrompt: string,
  userText: string,
  maxTokens?: number
): Promise<string> {
  return model === "claude"
    ? claudeComplete(env.anthropicApiKey, systemPrompt, userText, maxTokens)
    : chatGptComplete(env.openaiApiKey, env.openaiModel, systemPrompt, userText, maxTokens);
}

/** Routes a single-turn completion using Step 3's model router, retrying on
 * the other model if the first fails — the same routing/fallback logic Chat
 * uses, reused here for structured tasks (email action-item scanning, reply
 * drafting) that aren't a multi-turn conversation. */
export async function routedComplete(
  env: LlmEnv,
  routingText: string,
  systemPrompt: string,
  userText: string,
  maxTokens?: number
): Promise<string> {
  const intended = routeToModel(routingText);
  const fallback: ModelChoice = intended === "claude" ? "chatgpt" : "claude";
  try {
    return await callModel(intended, env, systemPrompt, userText, maxTokens);
  } catch (primaryError) {
    console.error(`[routedComplete] ${intended} failed, falling back to ${fallback}:`, primaryError);
    return await callModel(fallback, env, systemPrompt, userText, maxTokens);
  }
}

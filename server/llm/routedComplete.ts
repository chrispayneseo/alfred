import { claudeComplete, claudeVisionComplete } from "./anthropic.js";
import type { LlmEnv } from "./env.js";
import { chatGptComplete, chatGptVisionComplete } from "./openai.js";
import { routeToModel, type ModelChoice } from "./router.js";

type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

async function callModel(
  model: ModelChoice,
  env: LlmEnv,
  systemPrompt: string,
  userText: string,
  maxTokens?: number,
  claudeModel?: string
): Promise<string> {
  return model === "claude"
    ? claudeComplete(env.anthropicApiKey, systemPrompt, userText, maxTokens, claudeModel)
    : chatGptComplete(env.openaiApiKey, env.openaiModel, systemPrompt, userText, maxTokens);
}

async function callVisionModel(
  model: ModelChoice,
  env: LlmEnv,
  systemPrompt: string,
  userText: string,
  imageBase64: string,
  imageMediaType: ImageMediaType,
  maxTokens?: number,
  claudeModel?: string
): Promise<string> {
  return model === "claude"
    ? claudeVisionComplete(env.anthropicApiKey, systemPrompt, userText, imageBase64, imageMediaType, maxTokens, claudeModel)
    : chatGptVisionComplete(env.openaiApiKey, env.openaiModel, systemPrompt, userText, imageBase64, imageMediaType, maxTokens);
}

/** Routes a single-turn completion using Step 3's model router, retrying on
 * the other model if the first fails — the same routing/fallback logic Chat
 * uses, reused here for structured tasks (email action-item scanning, reply
 * drafting) that aren't a multi-turn conversation. `claudeModel` lets cheap
 * classification-style callers opt into a lighter model than Chat's default
 * Opus (falls back to claudeComplete's own default when omitted). */
export async function routedComplete(
  env: LlmEnv,
  routingText: string,
  systemPrompt: string,
  userText: string,
  maxTokens?: number,
  claudeModel?: string
): Promise<string> {
  const intended = routeToModel(routingText);
  const fallback: ModelChoice = intended === "claude" ? "chatgpt" : "claude";
  try {
    return await callModel(intended, env, systemPrompt, userText, maxTokens, claudeModel);
  } catch (primaryError) {
    console.error(`[routedComplete] ${intended} failed, falling back to ${fallback}:`, primaryError);
    return await callModel(fallback, env, systemPrompt, userText, maxTokens, claudeModel);
  }
}

/** Same routing/fallback contract as routedComplete, plus a single image —
 * used for the calendar-photo extraction pipeline (vision-capable models
 * only, which both Claude and GPT-4-class models are). */
export async function routedVisionComplete(
  env: LlmEnv,
  routingText: string,
  systemPrompt: string,
  userText: string,
  imageBase64: string,
  imageMediaType: ImageMediaType,
  maxTokens?: number,
  claudeModel?: string
): Promise<string> {
  const intended = routeToModel(routingText);
  const fallback: ModelChoice = intended === "claude" ? "chatgpt" : "claude";
  try {
    return await callVisionModel(intended, env, systemPrompt, userText, imageBase64, imageMediaType, maxTokens, claudeModel);
  } catch (primaryError) {
    console.error(`[routedVisionComplete] ${intended} failed, falling back to ${fallback}:`, primaryError);
    return await callVisionModel(fallback, env, systemPrompt, userText, imageBase64, imageMediaType, maxTokens, claudeModel);
  }
}

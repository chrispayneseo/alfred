import { claudeChat } from "./anthropic";
import type { LlmEnv } from "./env";
import { chatGptChat } from "./openai";
import { routeToModel, type ModelChoice } from "./router";
import type { ChatTurn } from "./types";

export interface ChatResult {
  text: string;
  model: ModelChoice;
  intendedModel: ModelChoice;
  fellBack: boolean;
}

async function callModel(model: ModelChoice, env: LlmEnv, messages: ChatTurn[]): Promise<string> {
  return model === "claude" ? claudeChat(env.anthropicApiKey, messages) : chatGptChat(env.openaiApiKey, env.openaiModel, messages);
}

/**
 * Routes to the intended model; if that call fails for any reason (network,
 * auth, hitting a spend cap), retries the same request against the other
 * model so a single provider outage doesn't take out Chat entirely. Throws
 * "both_unavailable" only when neither model could answer.
 */
export async function runChat(env: LlmEnv, messages: ChatTurn[]): Promise<ChatResult> {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const intended = routeToModel(lastUserMessage?.content ?? "");
  const fallback: ModelChoice = intended === "claude" ? "chatgpt" : "claude";

  try {
    const text = await callModel(intended, env, messages);
    return { text, model: intended, intendedModel: intended, fellBack: false };
  } catch (primaryError) {
    console.error(`[chat] ${intended} failed, falling back to ${fallback}:`, primaryError);
    try {
      const text = await callModel(fallback, env, messages);
      return { text, model: fallback, intendedModel: intended, fellBack: true };
    } catch (fallbackError) {
      console.error(`[chat] ${fallback} fallback also failed:`, fallbackError);
      throw new Error("both_unavailable");
    }
  }
}

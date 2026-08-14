import type { GoogleEnv } from "../google/env";
import { claudeChat } from "./anthropic";
import { buildCalendarContext, needsCalendarContext } from "./calendarContext";
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

async function callModel(model: ModelChoice, env: LlmEnv, messages: ChatTurn[], extraContext?: string): Promise<string> {
  return model === "claude"
    ? claudeChat(env.anthropicApiKey, messages, extraContext)
    : chatGptChat(env.openaiApiKey, env.openaiModel, messages, extraContext);
}

/**
 * Routes to the intended model; if that call fails for any reason (network,
 * auth, hitting a spend cap), retries the same request against the other
 * model so a single provider outage doesn't take out Chat entirely. Throws
 * "both_unavailable" only when neither model could answer.
 *
 * If the message looks calendar-related, fetches real events first and gives
 * them to the model as context — rather than letting it guess at the answer.
 */
export async function runChat(env: LlmEnv, googleEnv: GoogleEnv, messages: ChatTurn[]): Promise<ChatResult> {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const lastText = lastUserMessage?.content ?? "";
  const intended = routeToModel(lastText);
  const fallback: ModelChoice = intended === "claude" ? "chatgpt" : "claude";

  const extraContext = needsCalendarContext(lastText) ? await buildCalendarContext(googleEnv) : undefined;

  try {
    const text = await callModel(intended, env, messages, extraContext);
    return { text, model: intended, intendedModel: intended, fellBack: false };
  } catch (primaryError) {
    console.error(`[chat] ${intended} failed, falling back to ${fallback}:`, primaryError);
    try {
      const text = await callModel(fallback, env, messages, extraContext);
      return { text, model: fallback, intendedModel: intended, fellBack: true };
    } catch (fallbackError) {
      console.error(`[chat] ${fallback} fallback also failed:`, fallbackError);
      throw new Error("both_unavailable");
    }
  }
}

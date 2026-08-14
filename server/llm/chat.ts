import type { GoogleAccountEnv } from "../google/accounts";
import type { NotionRepo } from "../notion/queries";
import { claudeChat } from "./anthropic";
import { buildCalendarContext, needsCalendarContext } from "./calendarContext";
import { buildEmailContext, needsEmailContext } from "./emailContext";
import type { LlmEnv } from "./env";
import { buildNotionContext, needsNotionContext } from "./notionContext";
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

/** Gathers whichever context sources (calendar, Notion, email) the question
 * actually looks like it needs, and concatenates them into one context block —
 * the same injection mechanism Step 4 introduced for calendar, just fed by
 * more than one source (and, as of Step 8, more than one Google account) now. */
async function buildContext(lastText: string, googleAccounts: GoogleAccountEnv[], notionRepo: NotionRepo | undefined): Promise<string | undefined> {
  const blocks: string[] = [];

  if (needsCalendarContext(lastText)) blocks.push(await buildCalendarContext(googleAccounts));
  if (needsEmailContext(lastText)) blocks.push(await buildEmailContext(googleAccounts, lastText));
  if (notionRepo && needsNotionContext(lastText)) blocks.push(await buildNotionContext(notionRepo, lastText));

  return blocks.length > 0 ? blocks.join("\n\n---\n\n") : undefined;
}

/**
 * Routes to the intended model; if that call fails for any reason (network,
 * auth, hitting a spend cap), retries the same request against the other
 * model so a single provider outage doesn't take out Chat entirely. Throws
 * "both_unavailable" only when neither model could answer.
 *
 * If the message looks like it needs calendar, email, or Notion data, fetches
 * it first and gives it to the model as context — rather than letting it guess.
 */
export async function runChat(
  env: LlmEnv,
  googleAccounts: GoogleAccountEnv[],
  notionRepo: NotionRepo | undefined,
  messages: ChatTurn[]
): Promise<ChatResult> {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const lastText = lastUserMessage?.content ?? "";
  const intended = routeToModel(lastText);
  const fallback: ModelChoice = intended === "claude" ? "chatgpt" : "claude";

  const extraContext = await buildContext(lastText, googleAccounts, notionRepo);

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

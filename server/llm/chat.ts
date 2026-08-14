import type { Env } from "../db.js";
import type { GoogleAccountEnv } from "../google/accounts.js";
import type { NotionRepo } from "../notion/queries.js";
import { claudeChat } from "./anthropic.js";
import { buildCalendarContext, needsCalendarContext } from "./calendarContext.js";
import { buildEmailContext, needsEmailContext } from "./emailContext.js";
import type { LlmEnv } from "./env.js";
import { buildNotionContext, needsNotionContext } from "./notionContext.js";
import { chatGptChat } from "./openai.js";
import { routeToModel, type ModelChoice } from "./router.js";
import type { ChatTurn } from "./types.js";

export type Confidence = "direct" | "inferred";

export interface ChatResult {
  text: string;
  model: ModelChoice;
  intendedModel: ModelChoice;
  fellBack: boolean;
  confidence: Confidence;
}

// Asked of every answer, not just ones with injected context — a plain
// conversational reply or general knowledge counts as DIRECT too. The tag is
// parsed out of the raw text below and never shown to the user; it's a
// self-report from the model, not a verified fact-check, so treat it as a
// soft signal rather than a guarantee.
const CONFIDENCE_INSTRUCTION = `After writing your answer, decide whether it is DIRECT (you found the fact explicitly — stated in the provided Notion/email/calendar context, in the conversation, or it's general knowledge that doesn't need a source) or INFERRED (you reasoned it from a pattern, precedent, or incomplete information, without anything explicitly confirming it). Then, on its own final line, output exactly one of:
[[CONFIDENCE: DIRECT]]
[[CONFIDENCE: INFERRED]]
That line must always be the very last thing you write, with nothing after it, and nothing else on that line.`;

const CONFIDENCE_TAG_RE = /\[\[CONFIDENCE:\s*(DIRECT|INFERRED)\s*\]\]\s*$/i;

/** Strips the trailing [[CONFIDENCE: ...]] tag the model was asked to add
 * and returns the clean text plus what it said. Defaults to "direct" (fails
 * open, no label) if the model didn't comply with the format — an absent or
 * malformed tag shouldn't surface a "best guess" label that wasn't earned. */
function extractConfidence(rawText: string): { text: string; confidence: Confidence } {
  const match = rawText.match(CONFIDENCE_TAG_RE);
  if (!match) return { text: rawText.trim(), confidence: "direct" };
  return {
    text: rawText.slice(0, match.index).trim(),
    confidence: match[1].toUpperCase() === "INFERRED" ? "inferred" : "direct",
  };
}

async function callModel(model: ModelChoice, env: LlmEnv, messages: ChatTurn[], extraContext?: string): Promise<string> {
  return model === "claude"
    ? claudeChat(env.anthropicApiKey, messages, extraContext)
    : chatGptChat(env.openaiApiKey, env.openaiModel, messages, extraContext);
}

/** Gathers whichever context sources (calendar, Notion, email) the question
 * actually looks like it needs, and concatenates them into one context block —
 * the same injection mechanism Step 4 introduced for calendar, just fed by
 * more than one source (and, as of Step 8, more than one Google account) now.
 * The confidence-tagging instruction is always appended, regardless of
 * whether any of those sources apply — it's a general Q&A capability, not
 * tied to any one context type. */
async function buildContext(
  dbEnv: Env,
  lastText: string,
  googleAccounts: GoogleAccountEnv[],
  notionRepo: NotionRepo | undefined
): Promise<string> {
  const blocks: string[] = [];

  if (needsCalendarContext(lastText)) blocks.push(await buildCalendarContext(dbEnv, googleAccounts));
  if (needsEmailContext(lastText)) blocks.push(await buildEmailContext(dbEnv, googleAccounts, lastText));
  if (notionRepo && needsNotionContext(lastText)) blocks.push(await buildNotionContext(notionRepo, lastText));

  return [...blocks, CONFIDENCE_INSTRUCTION].join("\n\n---\n\n");
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
  dbEnv: Env,
  googleAccounts: GoogleAccountEnv[],
  notionRepo: NotionRepo | undefined,
  messages: ChatTurn[]
): Promise<ChatResult> {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const lastText = lastUserMessage?.content ?? "";
  const intended = routeToModel(lastText);
  const fallback: ModelChoice = intended === "claude" ? "chatgpt" : "claude";

  const extraContext = await buildContext(dbEnv, lastText, googleAccounts, notionRepo);

  try {
    const raw = await callModel(intended, env, messages, extraContext);
    const { text, confidence } = extractConfidence(raw);
    return { text, model: intended, intendedModel: intended, fellBack: false, confidence };
  } catch (primaryError) {
    console.error(`[chat] ${intended} failed, falling back to ${fallback}:`, primaryError);
    try {
      const raw = await callModel(fallback, env, messages, extraContext);
      const { text, confidence } = extractConfidence(raw);
      return { text, model: fallback, intendedModel: intended, fellBack: true, confidence };
    } catch (fallbackError) {
      console.error(`[chat] ${fallback} fallback also failed:`, fallbackError);
      throw new Error("both_unavailable");
    }
  }
}

import type { CoachPlanEnv } from "../coachplan/env.js";
import type { Env } from "../db.js";
import type { GoogleAccountEnv } from "../google/accounts.js";
import { DEFAULT_TIME_ZONE } from "../google/calendar.js";
import { WRITABLE_CALENDAR_ACCOUNT } from "../google/calendarWriteGuard.js";
import type { NotionRepo } from "../notion/queries.js";
import { DIGEST_PROJECTS, UNSORTED_PROJECT } from "../notion/schema.js";
import type { WeatherEnv } from "../weather/env.js";
import { logModelCall } from "../costTracking/callLog.js";
import { claudeChat } from "./anthropic.js";
import { buildCalendarContext, needsCalendarContext } from "./calendarContext.js";
import { buildCoachPlanContext, needsCoachPlanContext } from "./coachPlanContext.js";
import { buildEmailContext, needsEmailContext } from "./emailContext.js";
import type { LlmEnv } from "./env.js";
import { buildNotionContext, needsNotionContext } from "./notionContext.js";
import { chatGptChat } from "./openai.js";
import { routeToModel, type ModelChoice } from "./router.js";
import { buildSearchConsoleContext, needsSearchConsoleContext } from "./searchConsoleContext.js";
import type { ChatTurn, CompletionResult } from "./types.js";
import { buildWeatherContext, needsWeatherContext } from "./weatherContext.js";

export type Confidence = "direct" | "inferred";

export interface EventProposal {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM — absent means an all-day event. */
  startTime?: string;
  endTime?: string;
  account: string;
}

export interface LocationReminderProposal {
  text: string;
  locationTrigger: string;
  project: string;
}

export interface ChatResult {
  text: string;
  model: ModelChoice;
  intendedModel: ModelChoice;
  fellBack: boolean;
  confidence: Confidence;
  eventProposal?: EventProposal;
  locationReminderProposal?: LocationReminderProposal;
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

// Chat cannot create a calendar event itself — this only ever produces a
// *proposal*, which the frontend renders as an explicit confirm/cancel
// card (never auto-created). The actual write happens in
// /api/calendar/create-event, which enforces WRITABLE_CALENDAR_ACCOUNT
// server-side regardless of what account is named here — this prompt just
// keeps the model from proposing something it can't actually deliver.
const EVENT_PROPOSAL_INSTRUCTION = `If the user is asking you to add, create, schedule, or book something on their calendar, you cannot create it directly — you can only propose it for their confirmation. Alfred can only ever write events to the "${WRITABLE_CALENDAR_ACCOUNT}" calendar — never any other connected account, even if asked. If the user specifically asks for a different account, tell them that isn't possible rather than proposing it anyway. Otherwise, if you have enough detail (at minimum a title and a date; assume 1 hour for a timed event with no stated end time; treat it as all-day if no time is given at all), write one short sentence proposing it (e.g. "Want me to add this to your calendar?"), then — after that sentence, and before the final confidence line — output exactly this block:
[[CALENDAR_EVENT_PROPOSAL]]
{"title": "...", "date": "YYYY-MM-DD", "startTime": "HH:MM" or null, "endTime": "HH:MM" or null, "account": "${WRITABLE_CALENDAR_ACCOUNT}"}
[[/CALENDAR_EVENT_PROPOSAL]]
If you're missing the title or date, ask a clarifying question instead — do not output this block until you actually have enough detail to propose a specific event. Never output it for any reason other than genuinely proposing an event the user just asked for.`;

const EVENT_PROPOSAL_RE = /\[\[CALENDAR_EVENT_PROPOSAL\]\]\s*([\s\S]*?)\s*\[\[\/CALENDAR_EVENT_PROPOSAL\]\]/;

/** Strips the [[CALENDAR_EVENT_PROPOSAL]] block (if present) and parses it.
 * Silently drops a malformed block rather than leaking raw JSON/tags into
 * the visible reply — a parse failure here just means no proposal card is
 * shown, not an error. */
function extractEventProposal(text: string): { text: string; eventProposal?: EventProposal } {
  const match = text.match(EVENT_PROPOSAL_RE);
  if (!match) return { text };

  const cleanText = (text.slice(0, match.index) + text.slice(match.index! + match[0].length)).trim();
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed.title !== "string" || typeof parsed.date !== "string" || typeof parsed.account !== "string") {
      return { text: cleanText };
    }
    return {
      text: cleanText,
      eventProposal: {
        title: parsed.title,
        date: parsed.date,
        startTime: typeof parsed.startTime === "string" ? parsed.startTime : undefined,
        endTime: typeof parsed.endTime === "string" ? parsed.endTime : undefined,
        account: parsed.account,
      },
    };
  } catch (error) {
    console.error("[chat] couldn't parse event proposal JSON:", error, match[1]);
    return { text: cleanText };
  }
}

// Chat cannot create a location-triggered reminder itself — same
// propose-then-confirm shape as calendar events. The actual write happens
// in /api/capture/location-reminder, only after the frontend renders this
// as a confirm/cancel card and the user confirms; Tasker never talks to
// Chat at all, only to /api/location-trigger (a completely different,
// token-authenticated route — see locationTrigger/webhook.ts).
const LOCATION_REMINDER_PROPOSAL_INSTRUCTION = `If the user asks to be reminded of something when they arrive at, get to, or are next at a specific place (e.g. "remind me to phone the doctors when I get home", "when I'm at the sports ground remind me to grab the cones"), you cannot set it up directly — you can only propose it for their confirmation. If you have both the reminder text and a clear place name, write one short sentence proposing it (e.g. "Want me to remind you to phone the doctors next time you're home?"), then — after that sentence, and before the final confidence line — output exactly this block:
[[LOCATION_REMINDER_PROPOSAL]]
{"text": "...", "locationTrigger": "...", "project": one of ${DIGEST_PROJECTS.join(", ")} or "${UNSORTED_PROJECT}"}
[[/LOCATION_REMINDER_PROPOSAL]]
"text" is just the action itself (e.g. "phone the doctors"), never the trigger clause. "locationTrigger" is the place name exactly as they said it. If the place is unclear or missing, ask a clarifying question instead — do not output this block until you have both. Never output it for any reason other than genuinely proposing a location reminder the user just asked for, and never output both this block and the calendar event block in the same reply.`;

const LOCATION_REMINDER_PROPOSAL_RE = /\[\[LOCATION_REMINDER_PROPOSAL\]\]\s*([\s\S]*?)\s*\[\[\/LOCATION_REMINDER_PROPOSAL\]\]/;

/** Strips the [[LOCATION_REMINDER_PROPOSAL]] block (if present) and parses
 * it — same "drop silently on a malformed block" philosophy as
 * extractEventProposal. */
function extractLocationReminderProposal(text: string): { text: string; locationReminderProposal?: LocationReminderProposal } {
  const match = text.match(LOCATION_REMINDER_PROPOSAL_RE);
  if (!match) return { text };

  const cleanText = (text.slice(0, match.index) + text.slice(match.index! + match[0].length)).trim();
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed.text !== "string" || typeof parsed.locationTrigger !== "string" || typeof parsed.project !== "string") {
      return { text: cleanText };
    }
    return {
      text: cleanText,
      locationReminderProposal: { text: parsed.text, locationTrigger: parsed.locationTrigger, project: parsed.project },
    };
  } catch (error) {
    console.error("[chat] couldn't parse location reminder proposal JSON:", error, match[1]);
    return { text: cleanText };
  }
}

async function callModel(model: ModelChoice, env: LlmEnv, messages: ChatTurn[], extraContext?: string): Promise<CompletionResult> {
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
function todayGrounding(): string {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long", timeZone: DEFAULT_TIME_ZONE });
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: DEFAULT_TIME_ZONE }); // en-CA gives YYYY-MM-DD
  return `Today's date is ${dateStr} (${weekday}) — resolve "today"/"tomorrow"/"next Friday" etc. against this, not your own training cutoff.`;
}

// Search Console questions are often multi-turn in a way calendar/email
// questions usually aren't — "since the beginning of August?" or a bare "yes"
// confirming a site/date guess carries no GSC keyword and no date/site
// mention on its own. A short recent window (both roles, so Alfred's own
// clarifying questions count as signal too) is what both the
// needsSearchConsoleContext check and the extraction step actually need to
// resolve a follow-up correctly instead of asking the user to repeat themselves.
function recentConversationWindow(messages: ChatTurn[], maxMessages = 6): string {
  return messages
    .slice(-maxMessages)
    .map((m) => `${m.role === "user" ? "User" : "Alfred"}: ${m.content}`)
    .join("\n");
}

async function buildContext(
  llmEnv: LlmEnv,
  dbEnv: Env,
  lastText: string,
  messages: ChatTurn[],
  googleAccounts: GoogleAccountEnv[],
  notionRepo: NotionRepo | undefined,
  coachPlanEnv: CoachPlanEnv,
  weatherEnv: WeatherEnv
): Promise<string> {
  const blocks: string[] = [todayGrounding()];

  if (needsCalendarContext(lastText)) blocks.push(await buildCalendarContext(dbEnv, googleAccounts));
  if (needsEmailContext(lastText)) blocks.push(await buildEmailContext(dbEnv, googleAccounts, lastText));
  if (notionRepo && needsNotionContext(lastText)) blocks.push(await buildNotionContext(notionRepo, lastText));
  if (needsCoachPlanContext(lastText)) blocks.push(await buildCoachPlanContext(coachPlanEnv));
  if (needsWeatherContext(lastText)) blocks.push(await buildWeatherContext(weatherEnv, dbEnv, googleAccounts));
  const searchConsoleWindow = recentConversationWindow(messages);
  if (needsSearchConsoleContext(searchConsoleWindow)) blocks.push(await buildSearchConsoleContext(dbEnv, llmEnv, googleAccounts, searchConsoleWindow));

  return [...blocks, EVENT_PROPOSAL_INSTRUCTION, LOCATION_REMINDER_PROPOSAL_INSTRUCTION, CONFIDENCE_INSTRUCTION].join("\n\n---\n\n");
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
  coachPlanEnv: CoachPlanEnv,
  weatherEnv: WeatherEnv,
  messages: ChatTurn[]
): Promise<ChatResult> {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const lastText = lastUserMessage?.content ?? "";
  const intended = routeToModel(lastText);
  const fallback: ModelChoice = intended === "claude" ? "chatgpt" : "claude";

  const extraContext = await buildContext(env, dbEnv, lastText, messages, googleAccounts, notionRepo, coachPlanEnv, weatherEnv);

  try {
    const { text: raw, inputTokens, outputTokens } = await callModel(intended, env, messages, extraContext);
    await logModelCall(dbEnv, {
      provider: intended,
      feature: "chat",
      model: intended === "claude" ? "claude-opus-5" : env.openaiModel,
      inputTokens,
      outputTokens,
    });
    const { text: afterConfidence, confidence } = extractConfidence(raw);
    const { text: afterEvent, eventProposal } = extractEventProposal(afterConfidence);
    const { text, locationReminderProposal } = extractLocationReminderProposal(afterEvent);
    return { text, model: intended, intendedModel: intended, fellBack: false, confidence, eventProposal, locationReminderProposal };
  } catch (primaryError) {
    console.error(`[chat] ${intended} failed, falling back to ${fallback}:`, primaryError);
    try {
      const { text: raw, inputTokens, outputTokens } = await callModel(fallback, env, messages, extraContext);
      await logModelCall(dbEnv, {
        provider: fallback,
        feature: "chat",
        model: fallback === "claude" ? "claude-opus-5" : env.openaiModel,
        inputTokens,
        outputTokens,
      });
      const { text: afterConfidence, confidence } = extractConfidence(raw);
      const { text: afterEvent, eventProposal } = extractEventProposal(afterConfidence);
      const { text, locationReminderProposal } = extractLocationReminderProposal(afterEvent);
      return { text, model: fallback, intendedModel: intended, fellBack: true, confidence, eventProposal, locationReminderProposal };
    } catch (fallbackError) {
      console.error(`[chat] ${fallback} fallback also failed:`, fallbackError);
      throw new Error("both_unavailable");
    }
  }
}

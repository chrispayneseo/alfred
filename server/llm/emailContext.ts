import type { GoogleEnv } from "../google/env";
import { getMessageBody, searchMessages } from "../google/gmail";
import { GoogleNotConnectedError, GoogleReconnectRequiredError } from "../google/errors";
import { deriveSearchQuery } from "./queryTerms";

const EMAIL_KEYWORDS = [
  "email",
  "emails",
  "inbox",
  "thread",
  "invoice",
  "reply",
  "replied",
  "sent me",
  "wrote",
  "attachment",
  "attached",
  "message from",
];

export function needsEmailContext(text: string): boolean {
  const lower = text.toLowerCase();
  return EMAIL_KEYWORDS.some((keyword) => lower.includes(keyword));
}

const MAX_RESULTS = 5;
// Only fetch full bodies for the top couple of hits — the rest stay at
// snippet level, keeping this a live, on-demand read rather than a bulk pull.
const BODY_FETCH_COUNT = 2;

/** Live Gmail search (not the local metadata cache, for accuracy) + on-demand
 * body fetch for the top matches, formatted for the model's system context.
 * Never throws — a connection problem becomes an honest note in the context. */
export async function buildEmailContext(env: GoogleEnv, text: string): Promise<string> {
  try {
    const matches = await searchMessages(env, deriveSearchQuery(text), MAX_RESULTS);
    if (matches.length === 0) return "No matching emails were found in the user's inbox for this question.";

    const withBodies = await Promise.all(
      matches.slice(0, BODY_FETCH_COUNT).map(async (m) => {
        const body = await getMessageBody(env, m.id).catch(() => m.snippet);
        return `From: ${m.sender}\nSubject: ${m.subject}\nDate: ${m.date}\nExcerpt: ${body.slice(0, 1500)}`;
      })
    );
    const snippetsOnly = matches
      .slice(BODY_FETCH_COUNT)
      .map((m) => `From: ${m.sender}\nSubject: ${m.subject}\nDate: ${m.date}\nSnippet: ${m.snippet}`);

    return `Here are matching emails from the user's inbox. Use them to answer precisely — do not guess.\n\n${[...withBodies, ...snippetsOnly].join("\n\n")}`;
  } catch (error) {
    if (error instanceof GoogleNotConnectedError) {
      return "The user's Gmail isn't connected yet. If they ask about email, tell them to connect it from the Today screen — don't guess.";
    }
    if (error instanceof GoogleReconnectRequiredError) {
      return "The user's Gmail connection needs to be reconnected. If they ask about email, tell them so — don't guess.";
    }
    console.error("[emailContext] search failed:", error);
    return "Email search couldn't be completed right now due to an error. Say so rather than guessing.";
  }
}

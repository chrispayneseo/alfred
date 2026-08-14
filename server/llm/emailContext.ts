import type { GoogleAccountEnv } from "../google/accounts";
import { markAccountNeedsReconnect, markAccountOk } from "../google/accountStatus";
import { GoogleNotConnectedError, GoogleReconnectRequiredError } from "../google/errors";
import { getMessageBody, searchMessages, type EmailMetadata } from "../google/gmail";
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

/** Searches every connected account in parallel and merges results by date —
 * a stale token on one account doesn't block search on the others (Step 8). */
async function searchAllAccounts(
  accounts: GoogleAccountEnv[],
  query: string
): Promise<{ matches: EmailMetadata[]; failedAccounts: string[] }> {
  const failedAccounts: string[] = [];
  const perAccount = await Promise.all(
    accounts.map(async (account) => {
      try {
        const results = await searchMessages(account, query, MAX_RESULTS);
        markAccountOk(account.email);
        return results;
      } catch (error) {
        if (error instanceof GoogleReconnectRequiredError) {
          markAccountNeedsReconnect(account.email);
          failedAccounts.push(account.email);
          return [];
        }
        throw error;
      }
    })
  );

  const matches = perAccount
    .flat()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_RESULTS);
  return { matches, failedAccounts };
}

/** Live Gmail search (not the local metadata cache, for accuracy) across all
 * connected accounts + on-demand body fetch for the top matches, formatted
 * for the model's system context. Never throws — a connection problem
 * becomes an honest note in the context. */
export async function buildEmailContext(accounts: GoogleAccountEnv[], text: string): Promise<string> {
  if (accounts.length === 0) {
    return "The user's Gmail isn't connected yet. If they ask about email, tell them to connect it from the Today screen — don't guess.";
  }

  try {
    const { matches, failedAccounts } = await searchAllAccounts(accounts, deriveSearchQuery(text));
    const failedNote = failedAccounts.length
      ? ` (note: ${failedAccounts.join(", ")} couldn't be searched — needs reconnecting; results below are from the user's other connected account(s) only)`
      : "";

    if (matches.length === 0) return `No matching emails were found in the user's inbox for this question.${failedNote}`;

    const withBodies = await Promise.all(
      matches.slice(0, BODY_FETCH_COUNT).map(async (m) => {
        const account = accounts.find((a) => a.email === m.accountEmail);
        const body = account ? await getMessageBody(account, m.id).catch(() => m.snippet) : m.snippet;
        return `From: ${m.sender}\nAccount: ${m.accountEmail}\nSubject: ${m.subject}\nDate: ${m.date}\nExcerpt: ${body.slice(0, 1500)}`;
      })
    );
    const snippetsOnly = matches
      .slice(BODY_FETCH_COUNT)
      .map((m) => `From: ${m.sender}\nAccount: ${m.accountEmail}\nSubject: ${m.subject}\nDate: ${m.date}\nSnippet: ${m.snippet}`);

    return `Here are matching emails from the user's inbox, across all their connected Google accounts (each tagged with which account it's from). Use them to answer precisely — do not guess.${failedNote}\n\n${[...withBodies, ...snippetsOnly].join("\n\n")}`;
  } catch (error) {
    if (error instanceof GoogleNotConnectedError) {
      return "The user's Gmail isn't connected yet. If they ask about email, tell them to connect it from the Today screen — don't guess.";
    }
    console.error("[emailContext] search failed:", error);
    return "Email search couldn't be completed right now due to an error. Say so rather than guessing.";
  }
}

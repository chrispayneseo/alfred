import type { Env } from "../db.js";
import type { GoogleAccountEnv } from "../google/accounts.js";
import { DEFAULT_TIME_ZONE } from "../google/calendar.js";
import { GoogleApiDisabledError, GoogleNotConnectedError, GoogleReconnectRequiredError } from "../google/errors.js";
import {
  displayNameForSite,
  listSitesAllAccounts,
  querySearchAnalytics,
  querySearchAnalyticsTotals,
  type AccountSites,
  type SearchAnalyticsTotals,
} from "../google/searchConsole.js";
import type { LlmEnv } from "./env.js";
import { extractSearchConsoleIntent } from "./searchConsoleQuery.js";

const SEARCH_CONSOLE_KEYWORDS = [
  "search console",
  "clicks",
  "impressions",
  "ctr",
  "click-through",
  "click through",
  "search traffic",
  "search performance",
  "search ranking",
  "rankings",
  "average position",
  "serp",
  "organic traffic",
  "search queries",
  "search query",
  "google search",
];

/** Keyword heuristic — same cheap, predictable approach as every other
 * needsXContext detector in this file's siblings (calendarContext.ts,
 * emailContext.ts). Site names themselves aren't part of the keyword set —
 * they're discovered dynamically, so there's no fixed list to match against
 * here; a bare site-name mention without any GSC-ish term ("how's Peacock
 * Search?") is ambiguous enough that it's reasonable to require one. */
export function needsSearchConsoleContext(text: string): boolean {
  const lower = text.toLowerCase();
  return SEARCH_CONSOLE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function todayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: DEFAULT_TIME_ZONE });
}

function formatPct(ctr: number): string {
  return `${(ctr * 100).toFixed(2)}%`;
}

function formatDelta(current: number, previous: number, decimals = 0): string {
  const diff = current - previous;
  const sign = diff > 0 ? "+" : diff < 0 ? "" : "±";
  if (previous === 0) return diff === 0 ? "no change" : `${sign}${diff.toFixed(decimals)} (previous period had none)`;
  const pct = (diff / previous) * 100;
  return `${sign}${diff.toFixed(decimals)} (${sign}${pct.toFixed(1)}%)`;
}

function formatTotals(totals: SearchAnalyticsTotals): string {
  return `${totals.clicks} clicks, ${totals.impressions} impressions, ${formatPct(totals.ctr)} CTR, average position ${totals.position.toFixed(1)}`;
}

/** Fetches real Search Console data — property discovery, a cheap
 * site+date-range extraction call, then the analytics query itself —
 * formatted for the model's system context. Never throws — a connection,
 * scope, or API-enablement problem becomes an honest note in the context,
 * same convention as calendarContext.ts/emailContext.ts. */
export async function buildSearchConsoleContext(dbEnv: Env, llmEnv: LlmEnv, accounts: GoogleAccountEnv[], text: string): Promise<string> {
  if (accounts.length === 0) {
    return "The user's Google Search Console isn't connected (no Google account is connected at all). If they ask about search performance, tell them to connect a Google account from the Today screen — don't guess.";
  }

  let accountSites: AccountSites[];
  let failedAccounts: string[];
  try {
    ({ accountSites, failedAccounts } = await listSitesAllAccounts(dbEnv, accounts));
  } catch (error) {
    if (error instanceof GoogleApiDisabledError) {
      return "The Search Console API isn't enabled for this Google Cloud project yet, so Alfred can't read any site data. Tell the user this needs enabling in Google Cloud Console before Search Console questions can be answered — don't guess.";
    }
    if (error instanceof GoogleReconnectRequiredError) {
      return "The user's Google Search Console access needs reconnecting (their connected Google account was authorized before this feature existed). Tell them to reconnect their Google account from Settings — don't guess at search performance.";
    }
    console.error("[searchConsoleContext] site discovery failed:", error);
    return "Search Console data couldn't be fetched right now due to an error. Say so rather than guessing.";
  }

  const allSites = accountSites.flatMap((as) => as.sites.map((s) => ({ ...s, account: as.account })));

  if (allSites.length === 0) {
    if (failedAccounts.length > 0) {
      return `No Search Console properties are visible yet — ${failedAccounts.join(", ")} needs reconnecting to grant Search Console access (it was connected before this feature existed). Tell the user to reconnect from Settings — don't guess at search performance.`;
    }
    return "No Search Console properties were found on the user's connected Google account(s). Tell them plainly that no properties are visible — don't guess at search performance.";
  }

  const sitesForExtraction = allSites.map((s) => ({ siteUrl: s.siteUrl, displayName: displayNameForSite(s.siteUrl) }));
  const intent = await extractSearchConsoleIntent(dbEnv, llmEnv, text, sitesForExtraction, todayIso());

  if (!intent) {
    return "Alfred couldn't determine which Search Console property or date range this question is about right now due to an error. Say so rather than guessing.";
  }

  if (intent.siteMatch === "none") {
    const names = sitesForExtraction.map((s) => s.displayName).join(", ");
    return `None of the user's connected Search Console properties (${names}) clearly match what they're asking about. Ask them to clarify which site they mean — don't guess.`;
  }

  if (intent.siteMatch === "ambiguous") {
    const candidates = intent.candidateSiteUrls.map((url) => displayNameForSite(url)).join(", ");
    return `More than one Search Console property could match what the user's asking about (${candidates}). Ask them which one they mean before answering — don't guess.`;
  }

  const matched = allSites.find((s) => s.siteUrl === intent.matchedSiteUrl);
  if (!matched) {
    return "Alfred couldn't resolve the matched Search Console property to a real one due to an internal error. Say so rather than guessing.";
  }

  const displayName = displayNameForSite(matched.siteUrl);
  try {
    const [totals, comparisonTotals, topQueries, topPages] = await Promise.all([
      querySearchAnalyticsTotals(matched.account, matched.siteUrl, intent.startDate, intent.endDate),
      intent.comparisonStartDate && intent.comparisonEndDate
        ? querySearchAnalyticsTotals(matched.account, matched.siteUrl, intent.comparisonStartDate, intent.comparisonEndDate)
        : Promise.resolve(undefined),
      querySearchAnalytics(matched.account, matched.siteUrl, { startDate: intent.startDate, endDate: intent.endDate, dimensions: ["query"], rowLimit: 10 }),
      querySearchAnalytics(matched.account, matched.siteUrl, { startDate: intent.startDate, endDate: intent.endDate, dimensions: ["page"], rowLimit: 10 }),
    ]);

    const comparisonBlock = comparisonTotals
      ? `\n\nCompared to the previous period (${intent.comparisonStartDate} to ${intent.comparisonEndDate}, which had ${formatTotals(comparisonTotals)}): clicks ${formatDelta(totals.clicks, comparisonTotals.clicks)}, impressions ${formatDelta(totals.impressions, comparisonTotals.impressions)}, average position ${formatDelta(totals.position, comparisonTotals.position, 1)} (lower position is better).`
      : "";

    const queriesBlock = topQueries.length
      ? `\n\nTop search queries driving traffic:\n${topQueries.map((r) => `- "${r.keys[0]}": ${r.clicks} clicks, ${r.impressions} impressions`).join("\n")}`
      : "\n\nNo search queries recorded any clicks/impressions in this period.";

    const pagesBlock = topPages.length
      ? `\n\nTop pages by traffic:\n${topPages.map((r) => `- ${r.keys[0]}: ${r.clicks} clicks, ${r.impressions} impressions`).join("\n")}`
      : "\n\nNo pages recorded any clicks/impressions in this period.";

    return `Here is real Google Search Console data for "${displayName}" (${intent.periodLabel}: ${intent.startDate} to ${intent.endDate}). Use it to answer precisely — do not guess or estimate beyond what's here. Note: Search Console data typically lags 2-3 days behind today, so the most recent couple of days in any range may show incomplete figures.\n\nTotals: ${formatTotals(totals)}.${comparisonBlock}${queriesBlock}${pagesBlock}`;
  } catch (error) {
    if (error instanceof GoogleApiDisabledError) {
      return "The Search Console API isn't enabled for this Google Cloud project yet. Tell the user this needs enabling in Google Cloud Console — don't guess.";
    }
    if (error instanceof GoogleReconnectRequiredError || error instanceof GoogleNotConnectedError) {
      return "The user's Google Search Console access needs reconnecting. Tell them to reconnect from Settings — don't guess at search performance.";
    }
    console.error("[searchConsoleContext] analytics query failed:", error);
    return `Search Console data for "${displayName}" couldn't be fetched right now due to an error. Say so rather than guessing.`;
  }
}

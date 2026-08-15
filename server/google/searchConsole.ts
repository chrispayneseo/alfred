// Read-only Google Search Console access (see SEARCH_CONSOLE_SCOPE in
// oauth.ts). Mirrors calendar.ts's structure exactly: a single-account
// primitive, a multi-account fan-out on top of it, and the same
// auth/reconnect error handling — plus a GoogleApiDisabledError check, since
// the Search Console API needs enabling per-project in Google Cloud Console
// (unlike Calendar/Gmail, which this app already had enabled from Step 5).
import { searchconsole_v1 } from "googleapis";
import type { Env } from "../db.js";
import { createAuthenticatedClient } from "./client.js";
import { markAccountNeedsReconnect, markAccountOk, type GoogleAccountEnv } from "./accounts.js";
import { GoogleApiDisabledError, GoogleNotConnectedError, GoogleReconnectRequiredError, isGoogleAuthError, isServiceDisabledError } from "./errors.js";

export interface SearchConsoleSite {
  /** e.g. "sc-domain:peacocksearch.co.uk" (domain property) or
   * "https://example.com/" (URL-prefix property) — passed back verbatim as
   * the `siteUrl` param on analytics queries. */
  siteUrl: string;
  permissionLevel: string;
}

export interface SearchAnalyticsTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Strips the "sc-domain:" prefix or a leading protocol/trailing slash, for
 * showing a property to the user/model as a plain domain name rather than
 * its raw API identifier. */
export function displayNameForSite(siteUrl: string): string {
  if (siteUrl.startsWith("sc-domain:")) return siteUrl.slice("sc-domain:".length);
  return siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function handleApiError(error: unknown): never {
  if (isServiceDisabledError(error)) throw new GoogleApiDisabledError(error);
  if (isGoogleAuthError(error)) throw new GoogleReconnectRequiredError(error);
  throw error;
}

/** Every Search Console property this account has at least read access to. */
export async function listSites(env: GoogleAccountEnv): Promise<SearchConsoleSite[]> {
  if (!env.refreshToken) throw new GoogleNotConnectedError();

  const auth = createAuthenticatedClient(env);
  const searchconsole = new searchconsole_v1.Searchconsole({ auth });

  try {
    const res = await searchconsole.sites.list();
    return (res.data.siteEntry ?? [])
      .filter((s): s is { siteUrl: string; permissionLevel: string } => Boolean(s.siteUrl))
      .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel ?? "unknown" }));
  } catch (error) {
    handleApiError(error);
  }
}

export interface AccountSites {
  account: GoogleAccountEnv;
  sites: SearchConsoleSite[];
}

/** Discovers properties across every connected account — properties aren't
 * hardcoded anywhere, so this is the only source of truth for "what sites
 * can Alfred report on." Same partial-failure shape as
 * calendar.ts's listEventsAllAccounts: one account needing reconnecting
 * doesn't hide another account's properties. */
export async function listSitesAllAccounts(
  dbEnv: Env,
  accounts: GoogleAccountEnv[]
): Promise<{ accountSites: AccountSites[]; failedAccounts: string[] }> {
  if (accounts.length === 0) throw new GoogleNotConnectedError();

  const failedAccounts: string[] = [];
  const accountSites = await Promise.all(
    accounts.map(async (account): Promise<AccountSites> => {
      try {
        const sites = await listSites(account);
        await markAccountOk(dbEnv, account.email);
        return { account, sites };
      } catch (error) {
        if (error instanceof GoogleReconnectRequiredError) {
          await markAccountNeedsReconnect(dbEnv, account.email);
          failedAccounts.push(account.email);
          return { account, sites: [] };
        }
        throw error;
      }
    })
  );

  return { accountSites, failedAccounts };
}

export interface SearchAnalyticsQueryOptions {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
}

/** Raw search analytics rows for one property. With no `dimensions`, GSC
 * returns a single totals row. */
export async function querySearchAnalytics(
  env: GoogleAccountEnv,
  siteUrl: string,
  options: SearchAnalyticsQueryOptions
): Promise<SearchAnalyticsRow[]> {
  if (!env.refreshToken) throw new GoogleNotConnectedError();

  const auth = createAuthenticatedClient(env);
  const searchconsole = new searchconsole_v1.Searchconsole({ auth });

  try {
    const res = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: options.startDate,
        endDate: options.endDate,
        dimensions: options.dimensions,
        rowLimit: options.rowLimit ?? 1000,
        type: "web",
      },
    });
    return (res.data.rows ?? []).map((r) => ({
      keys: r.keys ?? [],
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }));
  } catch (error) {
    handleApiError(error);
  }
}

/** Convenience wrapper for the common "just give me the totals" case (no
 * dimensions) — zero rows (no data for the period) is a real, valid answer,
 * not an error, so this returns zeros rather than throwing or returning
 * undefined. */
export async function querySearchAnalyticsTotals(env: GoogleAccountEnv, siteUrl: string, startDate: string, endDate: string): Promise<SearchAnalyticsTotals> {
  const rows = await querySearchAnalytics(env, siteUrl, { startDate, endDate });
  const row = rows[0];
  return row ? { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position } : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
}

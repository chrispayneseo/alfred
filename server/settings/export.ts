import type { GoogleAccountEnv } from "../google/accounts";
import { CALENDAR_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, USERINFO_EMAIL_SCOPE } from "../google/oauth";
import { getAllEmails, getMeta } from "../google/gmailStore";
import { getAllPushedNudges } from "../nudges/nudgeStore";
import type { NotionEnv } from "../notion/env";
import type { NtfyEnv } from "../notify/env";

/** Everything Alfred holds a local copy or cache of — deliberately excludes
 * every credential (Notion token, Anthropic/OpenAI keys, Google client
 * secret/refresh tokens) since those are Alfred's own operating credentials,
 * not "your data" in the sense this export is for. Notion content itself is
 * out of scope too — it's already the source of truth and exportable from
 * Notion directly. */
export function buildExport(googleAccounts: GoogleAccountEnv[], notionEnv: NotionEnv, ntfyEnv: NtfyEnv) {
  return {
    exportedAt: new Date().toISOString(),
    integrations: {
      notion: { connected: Boolean(notionEnv.token) },
      google: {
        connected: googleAccounts.length > 0,
        accounts: googleAccounts.map((a) => a.email),
        scopes: [CALENDAR_READONLY_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE, USERINFO_EMAIL_SCOPE],
      },
      ntfy: { topic: ntfyEnv.topic || null },
    },
    gmailCache: {
      lastSyncAt: getMeta("lastSyncAt") ?? null,
      emails: getAllEmails(),
    },
    nudgePushHistory: getAllPushedNudges(),
  };
}

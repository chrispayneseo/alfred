import type { Env } from "../db.js";
import type { GoogleAccountEnv } from "../google/accounts.js";
import { CALENDAR_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, USERINFO_EMAIL_SCOPE } from "../google/oauth.js";
import { getAllEmails, getMeta } from "../google/gmailStore.js";
import { getAllPushedNudges } from "../nudges/nudgeStore.js";
import type { NotionEnv } from "../notion/env.js";
import type { NtfyEnv } from "../notify/env.js";

/** Everything Alfred holds a local copy or cache of — deliberately excludes
 * every credential (Notion token, Anthropic/OpenAI keys, Google client
 * secret/refresh tokens) since those are Alfred's own operating credentials,
 * not "your data" in the sense this export is for. Notion content itself is
 * out of scope too — it's already the source of truth and exportable from
 * Notion directly. */
export async function buildExport(env: Env, googleAccounts: GoogleAccountEnv[], notionEnv: NotionEnv, ntfyEnv: NtfyEnv) {
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
      lastSyncAt: (await getMeta(env, "lastSyncAt")) ?? null,
      emails: await getAllEmails(env),
    },
    nudgePushHistory: await getAllPushedNudges(env),
  };
}

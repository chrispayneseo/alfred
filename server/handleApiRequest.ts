// Transport-agnostic route handling — the actual "/api/*" logic, extracted
// so it can be driven by two different adapters: server/apiPlugin.ts (a Vite
// dev-server plugin, local `npm run dev`) and api/[...path].ts (a Vercel
// Node.js serverless function, production). Neither adapter contains any
// routing logic of its own; they just normalize their platform's request
// into an ApiRequest and turn an ApiResult back into a real response.
import type { Env } from "./db.js";
import { connectAccount, listAccountsWithHealth, loadGoogleAccounts, removeAccount } from "./google/accounts.js";
import { getTodayEventsAllAccounts, getTomorrowEventsAllAccounts, type MultiAccountEvents } from "./google/calendar.js";
import { loadGoogleEnv } from "./google/env.js";
import { GoogleNotConnectedError, GoogleReconnectRequiredError } from "./google/errors.js";
import { exchangeCodeForRefreshToken, getAuthUrl, isValidState, revokeToken } from "./google/oauth.js";
import { getSyncStatus, startSync } from "./google/gmailSync.js";
import { clearEmailsForAccount, countFlagged, countTotal, countUnscanned, dismissFlaggedEmail, getFlaggedEmails, getMeta } from "./google/gmailStore.js";
import { getScanStatus, startScan } from "./llm/emailScan.js";
import { runChat } from "./llm/chat.js";
import { classifyWithModel } from "./llm/classify.js";
import { loadLlmEnv } from "./llm/env.js";
import type { ChatTurn } from "./llm/types.js";
import { runNudgeCheck } from "./nudges/check.js";
import { createNotionClient } from "./notion/client.js";
import { loadNotionEnv } from "./notion/env.js";
import { NotionRepo } from "./notion/queries.js";
import { loadNtfyEnv } from "./notify/env.js";
import { buildExport } from "./settings/export.js";
import { wipeEverything } from "./settings/wipe.js";

export interface ApiRequest {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  readBody: () => Promise<Record<string, unknown>>;
  env: Env;
  /** Lets a route return a response while work keeps going: fire-and-forget
   * locally (apiPlugin.ts, fine in a long-lived dev process), Vercel's
   * waitUntil() in production (api/[...path].ts, extends the invocation
   * past the initial response, up to the function's maxDuration). */
  backgroundTask: (task: Promise<unknown>) => void;
}

export type ApiResult = { kind: "json"; status: number; body: unknown } | { kind: "redirect"; location: string };

function json(status: number, body: unknown): ApiResult {
  return { kind: "json", status, body };
}

function redirect(location: string): ApiResult {
  return { kind: "redirect", location };
}

function isChatTurn(value: unknown): value is ChatTurn {
  if (typeof value !== "object" || value === null) return false;
  const { role, content } = value as { role?: unknown; content?: unknown };
  return (role === "user" || role === "assistant") && typeof content === "string";
}

async function calendarEventsResult(fetchEvents: () => Promise<MultiAccountEvents>): Promise<ApiResult> {
  try {
    return json(200, await fetchEvents());
  } catch (error) {
    if (error instanceof GoogleNotConnectedError) return json(409, { error: "not_connected" });
    if (error instanceof GoogleReconnectRequiredError) return json(409, { error: "reconnect_required" });
    throw error;
  }
}

export async function handleApiRequest(req: ApiRequest): Promise<ApiResult> {
  const { method, pathname, searchParams, readBody, env, backgroundTask } = req;

  try {
    const notionEnv = loadNotionEnv(env);
    const llmEnv = loadLlmEnv(env);
    const repo = notionEnv.token ? new NotionRepo(createNotionClient(notionEnv.token), notionEnv) : undefined;

    if (method === "POST" && pathname === "/api/chat") {
      const body = await readBody();
      const messages = Array.isArray(body.messages) ? body.messages.filter(isChatTurn) : [];
      if (messages.length === 0) return json(400, { error: "messages is required" });

      try {
        const accounts = await loadGoogleAccounts(env);
        const result = await runChat(llmEnv, env, accounts, repo, messages);
        return json(200, result);
      } catch (error) {
        if (error instanceof Error && error.message === "both_unavailable") {
          return json(502, { error: "both_unavailable" });
        }
        throw error;
      }
    }

    // Google Calendar/Gmail: accounts are re-read per request (not hoisted)
    // so a freshly-connected/disconnected account is picked up immediately.
    if (method === "GET" && pathname === "/api/google/status") {
      const accounts = await loadGoogleAccounts(env);
      return json(200, { connected: accounts.length > 0 });
    }

    if (method === "GET" && pathname === "/api/google/accounts") {
      return json(200, await listAccountsWithHealth(env));
    }

    if (method === "GET" && pathname === "/api/google/auth/start") {
      const googleEnv = loadGoogleEnv(env);
      if (!googleEnv.clientId || !googleEnv.clientSecret) {
        return json(503, {
          error: "Google OAuth isn't configured yet — check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.",
        });
      }
      // ?email= is set when reconnecting a specific already-connected
      // account from Settings, to pre-select it in Google's picker. Omitted
      // when connecting a brand new account.
      const loginHint = searchParams.get("email") ?? undefined;
      return redirect(getAuthUrl(googleEnv, { loginHint }));
    }

    if (method === "GET" && pathname === "/api/google/oauth/callback") {
      const googleEnv = loadGoogleEnv(env);
      const error = searchParams.get("error");
      if (error) return redirect(`/today?calendar=denied`);

      const code = searchParams.get("code");
      const state = searchParams.get("state");
      if (!code || !isValidState(state, googleEnv.clientSecret)) return redirect(`/today?calendar=error`);

      try {
        const refreshToken = await exchangeCodeForRefreshToken(googleEnv, code);
        // Upserts by the account's real email — handles "connect the first
        // account", "connect another account", and "reconnect an existing
        // one" all through the same path (Step 8).
        await connectAccount(env, googleEnv, refreshToken);
        return redirect(`/today?calendar=connected`);
      } catch (exchangeError) {
        console.error(exchangeError);
        return redirect(`/today?calendar=error`);
      }
    }

    const disconnectMatch = pathname.match(/^\/api\/google\/accounts\/([^/]+)\/disconnect$/);
    if (method === "POST" && disconnectMatch) {
      const email = decodeURIComponent(disconnectMatch[1]);
      const account = (await loadGoogleAccounts(env)).find((a) => a.email === email);
      if (!account) return json(404, { error: "Account not found." });

      await revokeToken(account);
      await removeAccount(env, email);
      await clearEmailsForAccount(env, email);
      return json(200, { ok: true });
    }

    if (method === "GET" && pathname === "/api/calendar/today") {
      const accounts = await loadGoogleAccounts(env);
      return await calendarEventsResult(() => getTodayEventsAllAccounts(env, accounts));
    }

    if (method === "GET" && pathname === "/api/calendar/tomorrow") {
      const accounts = await loadGoogleAccounts(env);
      return await calendarEventsResult(() => getTomorrowEventsAllAccounts(env, accounts));
    }

    if (method === "GET" && pathname === "/api/gmail/status") {
      const accounts = await loadGoogleAccounts(env);
      return json(200, {
        connected: accounts.length > 0,
        lastSyncAt: await getMeta(env, "lastSyncAt"),
        totalEmails: await countTotal(env),
        unscannedCount: await countUnscanned(env),
        flaggedCount: await countFlagged(env),
      });
    }

    if (method === "POST" && pathname === "/api/gmail/sync/start") {
      const accounts = await loadGoogleAccounts(env);
      if (accounts.length === 0) return json(409, { error: "not_connected" });
      const body = await readBody();
      const days = typeof body.days === "number" && body.days > 0 ? Math.min(body.days, 90) : 30;
      return json(200, await startSync(env, accounts, days, backgroundTask));
    }

    if (method === "GET" && pathname === "/api/gmail/sync/status") {
      return json(200, await getSyncStatus(env));
    }

    if (method === "POST" && pathname === "/api/gmail/scan/start") {
      const accounts = await loadGoogleAccounts(env);
      if (accounts.length === 0) return json(409, { error: "not_connected" });
      if (!repo) return json(503, { error: "Notion isn't configured yet." });
      const body = await readBody();
      const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 100) : 20;
      return json(200, await startScan(env, llmEnv, accounts, repo, limit, backgroundTask));
    }

    if (method === "GET" && pathname === "/api/gmail/scan/status") {
      return json(200, await getScanStatus(env));
    }

    if (method === "GET" && pathname === "/api/gmail/flagged") {
      return json(200, await getFlaggedEmails(env));
    }

    if (method === "POST" && pathname === "/api/gmail/flagged/dismiss") {
      const body = await readBody();
      if (typeof body.accountEmail === "string" && typeof body.id === "string") {
        await dismissFlaggedEmail(env, body.accountEmail, body.id);
      }
      return json(200, { ok: true });
    }

    if (method === "POST" && pathname === "/api/nudges/check") {
      if (!repo) return json(503, { error: "Notion isn't configured yet." });
      return json(200, await runNudgeCheck(env, llmEnv, loadNtfyEnv(env), repo));
    }

    if (method === "GET" && pathname === "/api/settings/export") {
      const accounts = await loadGoogleAccounts(env);
      return json(200, await buildExport(env, accounts, notionEnv, loadNtfyEnv(env)));
    }

    if (method === "POST" && pathname === "/api/settings/wipe") {
      const body = await readBody();
      if (body.confirm !== "delete") return json(400, { error: 'Type "delete" to confirm.' });
      const accounts = await loadGoogleAccounts(env);
      await wipeEverything(env, accounts);
      return json(200, { ok: true });
    }

    if (!repo) {
      return json(503, { error: "Notion isn't configured yet — check NOTION_TOKEN and the *_DB_ID vars in .env." });
    }

    if (method === "POST" && pathname === "/api/capture") {
      const body = await readBody();
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const source = body.source === "share-target" ? "share-target" : "manual";
      if (!text) return json(400, { error: "text is required" });

      const inbox = await repo.createInboxPage(text, source);
      const classification = await classifyWithModel(llmEnv.anthropicApiKey, text);
      const filed = await repo.fileClassifiedItem(inbox.id, text, classification);
      return json(200, { inbox, filed });
    }

    if (method === "GET" && pathname === "/api/projects") {
      return json(200, await repo.listProjects());
    }

    if (method === "GET" && pathname === "/api/tasks") {
      const projectId = searchParams.get("project") ?? undefined;
      return json(200, await repo.listTasks(projectId));
    }

    if (method === "GET" && pathname === "/api/notes") {
      const projectId = searchParams.get("project") ?? undefined;
      return json(200, await repo.listNotes(projectId));
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === "PATCH" && taskMatch) {
      const body = await readBody();
      if (typeof body.done === "boolean") await repo.updateTaskStatus(taskMatch[1], body.done);
      if (typeof body.projectId === "string") await repo.setTaskProject(taskMatch[1], body.projectId);
      return json(200, { ok: true });
    }
    if (method === "DELETE" && taskMatch) {
      await repo.archiveTask(taskMatch[1]);
      return json(200, { ok: true });
    }

    const noteMatch = pathname.match(/^\/api\/notes\/([^/]+)$/);
    if (method === "PATCH" && noteMatch) {
      const body = await readBody();
      if (typeof body.projectId === "string") await repo.setNoteProject(noteMatch[1], body.projectId);
      return json(200, { ok: true });
    }

    return json(404, { error: "not found" });
  } catch (error) {
    console.error(error);
    return json(500, { error: error instanceof Error ? error.message : "internal error" });
  }
}

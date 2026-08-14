import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { updateEnvFile } from "./envFile";
import { connectAccount, loadGoogleAccounts, removeAccount } from "./google/accounts";
import { clearAccountHealth, getAccountHealth } from "./google/accountStatus";
import { getTodayEventsAllAccounts, getTomorrowEventsAllAccounts, type MultiAccountEvents } from "./google/calendar";
import { loadGoogleEnv } from "./google/env";
import { GoogleNotConnectedError, GoogleReconnectRequiredError } from "./google/errors";
import { exchangeCodeForRefreshToken, getAuthUrl, isValidState, revokeToken } from "./google/oauth";
import { getSyncStatus, startSync } from "./google/gmailSync";
import { clearEmailsForAccount, countFlagged, countTotal, countUnscanned, getFlaggedEmails, getMeta } from "./google/gmailStore";
import { getScanStatus, startScan } from "./llm/emailScan";
import { runChat } from "./llm/chat";
import { classifyWithModel } from "./llm/classify";
import { loadLlmEnv } from "./llm/env";
import type { ChatTurn } from "./llm/types";
import { runNudgeCheck } from "./nudges/check";
import { createNotionClient } from "./notion/client";
import { loadNotionEnv } from "./notion/env";
import { NotionRepo } from "./notion/queries";
import { loadNtfyEnv } from "./notify/env";
import { buildExport } from "./settings/export";
import { wipeEverything } from "./settings/wipe";

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sendRedirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

function isChatTurn(value: unknown): value is ChatTurn {
  if (typeof value !== "object" || value === null) return false;
  const { role, content } = value as { role?: unknown; content?: unknown };
  return (role === "user" || role === "assistant") && typeof content === "string";
}

async function sendCalendarEvents(res: ServerResponse, fetchEvents: () => Promise<MultiAccountEvents>) {
  try {
    return sendJson(res, 200, await fetchEvents());
  } catch (error) {
    if (error instanceof GoogleNotConnectedError) return sendJson(res, 409, { error: "not_connected" });
    if (error instanceof GoogleReconnectRequiredError) return sendJson(res, 409, { error: "reconnect_required" });
    throw error;
  }
}

/** Dev-only API layer: keeps the Notion/Anthropic/OpenAI/Google credentials
 * server-side and sidesteps the Notion API's lack of CORS support for browser
 * calls. Gets replaced by Supabase Edge Functions in a later step. */
export function apiPlugin(): Plugin {
  return {
    name: "alfred-api",
    configureServer(server) {
      const notionEnv = loadNotionEnv();
      const repo = notionEnv.token ? new NotionRepo(createNotionClient(notionEnv.token), notionEnv) : undefined;
      const llmEnv = loadLlmEnv();

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();

        const url = new URL(req.url, "http://localhost");
        const method = req.method ?? "GET";

        try {
          if (method === "POST" && url.pathname === "/api/chat") {
            const body = await readJsonBody(req);
            const messages = Array.isArray(body.messages) ? body.messages.filter(isChatTurn) : [];
            if (messages.length === 0) return sendJson(res, 400, { error: "messages is required" });

            try {
              const accounts = loadGoogleAccounts(loadGoogleEnv());
              const result = await runChat(llmEnv, accounts, repo, messages);
              return sendJson(res, 200, result);
            } catch (error) {
              if (error instanceof Error && error.message === "both_unavailable") {
                return sendJson(res, 502, { error: "both_unavailable" });
              }
              throw error;
            }
          }

          // Google Calendar/Gmail: accounts are re-read per request (not
          // hoisted at server start) so a freshly-connected/disconnected
          // account is picked up immediately, no server restart required.
          if (method === "GET" && url.pathname === "/api/google/status") {
            const accounts = loadGoogleAccounts(loadGoogleEnv());
            return sendJson(res, 200, { connected: accounts.length > 0 });
          }

          if (method === "GET" && url.pathname === "/api/google/accounts") {
            const accounts = loadGoogleAccounts(loadGoogleEnv());
            return sendJson(res, 200, accounts.map((a) => ({ email: a.email, status: getAccountHealth(a.email) })));
          }

          if (method === "GET" && url.pathname === "/api/google/auth/start") {
            const googleEnv = loadGoogleEnv();
            if (!googleEnv.clientId || !googleEnv.clientSecret) {
              return sendJson(res, 503, {
                error: "Google OAuth isn't configured yet — check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.",
              });
            }
            // ?email= is set when reconnecting a specific already-connected
            // account from Settings, to pre-select it in Google's picker.
            // Omitted when connecting a brand new account.
            const loginHint = url.searchParams.get("email") ?? undefined;
            return sendRedirect(res, getAuthUrl(googleEnv, { loginHint }));
          }

          if (method === "GET" && url.pathname === "/api/google/oauth/callback") {
            const googleEnv = loadGoogleEnv();
            const error = url.searchParams.get("error");
            if (error) return sendRedirect(res, `/today?calendar=denied`);

            const code = url.searchParams.get("code");
            const state = url.searchParams.get("state");
            if (!code || !isValidState(state)) return sendRedirect(res, `/today?calendar=error`);

            try {
              const refreshToken = await exchangeCodeForRefreshToken(googleEnv, code);
              // Upserts by the account's real email — handles "connect the
              // first account", "connect another account", and "reconnect an
              // existing one" all through the same path (Step 8).
              await connectAccount(googleEnv, refreshToken);
              return sendRedirect(res, `/today?calendar=connected`);
            } catch (exchangeError) {
              console.error(exchangeError);
              return sendRedirect(res, `/today?calendar=error`);
            }
          }

          const disconnectMatch = url.pathname.match(/^\/api\/google\/accounts\/([^/]+)\/disconnect$/);
          if (method === "POST" && disconnectMatch) {
            const email = decodeURIComponent(disconnectMatch[1]);
            const googleEnv = loadGoogleEnv();
            const account = loadGoogleAccounts(googleEnv).find((a) => a.email === email);
            if (!account) return sendJson(res, 404, { error: "Account not found." });

            await revokeToken(account);
            removeAccount(email);
            clearEmailsForAccount(email);
            clearAccountHealth(email);
            return sendJson(res, 200, { ok: true });
          }

          if (method === "GET" && url.pathname === "/api/calendar/today") {
            const accounts = loadGoogleAccounts(loadGoogleEnv());
            return await sendCalendarEvents(res, () => getTodayEventsAllAccounts(accounts));
          }

          if (method === "GET" && url.pathname === "/api/calendar/tomorrow") {
            const accounts = loadGoogleAccounts(loadGoogleEnv());
            return await sendCalendarEvents(res, () => getTomorrowEventsAllAccounts(accounts));
          }

          if (method === "GET" && url.pathname === "/api/gmail/status") {
            const accounts = loadGoogleAccounts(loadGoogleEnv());
            return sendJson(res, 200, {
              connected: accounts.length > 0,
              lastSyncAt: getMeta("lastSyncAt"),
              totalEmails: countTotal(),
              unscannedCount: countUnscanned(),
              flaggedCount: countFlagged(),
            });
          }

          if (method === "POST" && url.pathname === "/api/gmail/sync/start") {
            const accounts = loadGoogleAccounts(loadGoogleEnv());
            if (accounts.length === 0) return sendJson(res, 409, { error: "not_connected" });
            const body = await readJsonBody(req);
            const days = typeof body.days === "number" && body.days > 0 ? Math.min(body.days, 90) : 30;
            return sendJson(res, 200, startSync(accounts, days));
          }

          if (method === "GET" && url.pathname === "/api/gmail/sync/status") {
            return sendJson(res, 200, getSyncStatus());
          }

          if (method === "POST" && url.pathname === "/api/gmail/scan/start") {
            const accounts = loadGoogleAccounts(loadGoogleEnv());
            if (accounts.length === 0) return sendJson(res, 409, { error: "not_connected" });
            if (!repo) return sendJson(res, 503, { error: "Notion isn't configured yet." });
            const body = await readJsonBody(req);
            const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 100) : 20;
            return sendJson(res, 200, startScan(llmEnv, accounts, repo, limit));
          }

          if (method === "GET" && url.pathname === "/api/gmail/scan/status") {
            return sendJson(res, 200, getScanStatus());
          }

          if (method === "GET" && url.pathname === "/api/gmail/flagged") {
            return sendJson(res, 200, getFlaggedEmails());
          }

          if (method === "POST" && url.pathname === "/api/nudges/check") {
            if (!repo) return sendJson(res, 503, { error: "Notion isn't configured yet." });
            return sendJson(res, 200, await runNudgeCheck(llmEnv, loadNtfyEnv(), repo));
          }

          if (method === "GET" && url.pathname === "/api/settings/export") {
            const accounts = loadGoogleAccounts(loadGoogleEnv());
            return sendJson(res, 200, buildExport(accounts, notionEnv, loadNtfyEnv()));
          }

          if (method === "POST" && url.pathname === "/api/settings/wipe") {
            const body = await readJsonBody(req);
            if (body.confirm !== "delete") return sendJson(res, 400, { error: "Type \"delete\" to confirm." });
            const accounts = loadGoogleAccounts(loadGoogleEnv());
            await wipeEverything(accounts);
            return sendJson(res, 200, { ok: true });
          }

          if (!repo) {
            sendJson(res, 503, { error: "Notion isn't configured yet — check NOTION_TOKEN and the *_DB_ID vars in .env." });
            return;
          }

          if (method === "POST" && url.pathname === "/api/capture") {
            const body = await readJsonBody(req);
            const text = typeof body.text === "string" ? body.text.trim() : "";
            const source = body.source === "share-target" ? "share-target" : "manual";
            if (!text) return sendJson(res, 400, { error: "text is required" });

            const inbox = await repo.createInboxPage(text, source);
            const classification = await classifyWithModel(llmEnv.anthropicApiKey, text);
            const filed = await repo.fileClassifiedItem(inbox.id, text, classification);
            return sendJson(res, 200, { inbox, filed });
          }

          if (method === "GET" && url.pathname === "/api/projects") {
            return sendJson(res, 200, await repo.listProjects());
          }

          if (method === "GET" && url.pathname === "/api/tasks") {
            const projectId = url.searchParams.get("project") ?? undefined;
            return sendJson(res, 200, await repo.listTasks(projectId));
          }

          if (method === "GET" && url.pathname === "/api/notes") {
            const projectId = url.searchParams.get("project") ?? undefined;
            return sendJson(res, 200, await repo.listNotes(projectId));
          }

          const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
          if (method === "PATCH" && taskMatch) {
            const body = await readJsonBody(req);
            if (typeof body.done === "boolean") await repo.updateTaskStatus(taskMatch[1], body.done);
            if (typeof body.projectId === "string") await repo.setTaskProject(taskMatch[1], body.projectId);
            return sendJson(res, 200, { ok: true });
          }

          const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
          if (method === "PATCH" && noteMatch) {
            const body = await readJsonBody(req);
            if (typeof body.projectId === "string") await repo.setNoteProject(noteMatch[1], body.projectId);
            return sendJson(res, 200, { ok: true });
          }

          sendJson(res, 404, { error: "not found" });
        } catch (error) {
          console.error(error);
          sendJson(res, 500, { error: error instanceof Error ? error.message : "internal error" });
        }
      });
    },
  };
}

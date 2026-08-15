// Transport-agnostic route handling — the actual "/api/*" logic, extracted
// so it can be driven by two different adapters: server/apiPlugin.ts (a Vite
// dev-server plugin, local `npm run dev`) and api/[...path].ts (a Vercel
// Node.js serverless function, production). Neither adapter contains any
// routing logic of its own; they just normalize their platform's request
// into an ApiRequest and turn an ApiResult back into a real response.
import { getUpcomingMatches, getUpcomingSessions } from "./coachplan/coachplan.js";
import { isCoachPlanConfigured, loadCoachPlanEnv } from "./coachplan/env.js";
import type { Env } from "./db.js";
import { connectAccount, listAccountsWithHealth, loadGoogleAccounts, removeAccount } from "./google/accounts.js";
import {
  createEvent,
  getTodayEventsAllAccounts,
  getTomorrowEventsAllAccounts,
  listEvents,
  type CalendarEventRecord,
  type MultiAccountEvents,
  type NewEventInput,
} from "./google/calendar.js";
import { assertWritableAccount, CalendarAccountNotWritableError, WRITABLE_CALENDAR_ACCOUNT } from "./google/calendarWriteGuard.js";
import { loadGoogleEnv } from "./google/env.js";
import { GoogleNotConnectedError, GoogleReconnectRequiredError } from "./google/errors.js";
import { extractCalendarPhoto } from "./calendarPhoto/extract.js";
import { buildReviewItems, extractionDateRange } from "./calendarPhoto/review.js";
import { exchangeCodeForRefreshToken, getAuthUrl, isValidState, revokeToken } from "./google/oauth.js";
import { getSyncStatus, startSync } from "./google/gmailSync.js";
import {
  clearEmailsForAccount,
  countFlagged,
  countTotal,
  countUnscanned,
  dismissFlaggedEmail,
  getFlaggedEmails,
  getMeta,
  searchEmailsByTerms,
} from "./google/gmailStore.js";
import { emailSearchTermsFor, isFreelanceClient } from "./freelance/clientContacts.js";
import { getScanStatus, startScan } from "./llm/emailScan.js";
import { runChat } from "./llm/chat.js";
import { isCaptureItem, splitAndClassifyCapture } from "./llm/splitCapture.js";
import { loadLlmEnv } from "./llm/env.js";
import { transcribeAudio } from "./llm/openai.js";
import type { ChatTurn } from "./llm/types.js";
import { runNudgeCheck } from "./nudges/check.js";
import { snoozeNudge } from "./nudges/nudgeStore.js";
import {
  checkWeeklyDigest,
  generateWeeklyDigestNow,
  getDigestTriggerDay,
  setDigestTriggerDay,
  type DigestTriggerDay,
} from "./digest/weeklyDigest.js";
import {
  acceptGrouping,
  checkProjectGroupings,
  dismissGrouping,
  listPendingGroupings,
  scanForProjectGroupings,
} from "./projectGroupings/projectGroupingDetection.js";
import {
  acceptSuggestion,
  checkRecurringTasks,
  dismissSuggestion,
  listPendingSuggestions,
  scanForRecurringPatterns,
} from "./recurring/recurringDetection.js";
import { createNotionClient } from "./notion/client.js";
import { loadNotionEnv } from "./notion/env.js";
import { NotionRepo } from "./notion/queries.js";
import { FREELANCE_CLIENTS } from "./notion/schema.js";
import { loadNtfyEnv } from "./notify/env.js";
import { buildExport } from "./settings/export.js";
import { wipeEverything } from "./settings/wipe.js";
import { loadWeatherEnv } from "./weather/env.js";
import { fetchWeatherBriefing } from "./weather/openMeteo.js";

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

// Generous ceiling for a base64-encoded short voice-capture clip (a few
// minutes at most) — well under Vercel's request body limits, just a sanity
// check against something going wrong client-side.
const MAX_AUDIO_BASE64_CHARS = 15_000_000;
// A phone photo of a calendar page comfortably fits well under this.
const MAX_PHOTO_BASE64_CHARS = 15_000_000;
const VALID_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const RECURRENCE_VALUES = new Set(["weekly", "monthly", "yearly"]);

interface ApprovedPhotoItem {
  kind: "single" | "recurring";
  title: string;
  date: string;
  endDate: string | null;
  time: string | null;
  /** Free text — the dropdown constrains it client-side, but nothing
   * security-sensitive hinges on it server-side (it only ever ends up as a
   * prefix on a title written to the user's own writable-account calendar). */
  person?: string;
  recurrence?: "weekly" | "monthly" | "yearly";
  /** Every occurrence date from a detected recurring group — used to expand
   * into individual events when the user picks no recurrence for one. */
  dates?: string[];
}

function isApprovedPhotoItem(value: unknown): value is ApprovedPhotoItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if ((v.kind !== "single" && v.kind !== "recurring") || typeof v.title !== "string" || typeof v.date !== "string") return false;
  if (v.person !== undefined && typeof v.person !== "string") return false;
  if (v.recurrence !== undefined && !RECURRENCE_VALUES.has(v.recurrence as string)) return false;
  if (v.dates !== undefined && !Array.isArray(v.dates)) return false;
  return true;
}

/** One approved review item may become one or several actual calendar
 * events (a "just these instances" recurring group becomes one event per
 * date) — this always writes every one of them, reporting per-event
 * success/failure, so a partial failure within one item is visible rather
 * than silently dropped. */
async function createEventsForApprovedItem(
  account: Parameters<typeof createEvent>[0],
  item: ApprovedPhotoItem
): Promise<{ ok: true } | { ok: false; error: string }> {
  const title = item.person ? `${item.person}: ${item.title}` : item.title;
  const base: NewEventInput = { title, date: item.date, endDate: item.endDate ?? undefined, startTime: item.time ?? undefined };

  try {
    if (item.recurrence) {
      await createEvent(account, { ...base, recurrence: item.recurrence.toUpperCase() as "WEEKLY" | "MONTHLY" | "YEARLY" });
      return { ok: true };
    }
    if (item.kind === "recurring" && item.dates && item.dates.length > 0) {
      for (const date of item.dates) {
        await createEvent(account, { ...base, date });
      }
      return { ok: true };
    }
    await createEvent(account, base);
    return { ok: true };
  } catch (error) {
    console.error("[calendarPhoto] failed to create event:", error);
    return { ok: false, error: error instanceof Error ? error.message : "Couldn't create that event." };
  }
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
    const coachPlanEnv = loadCoachPlanEnv(env);
    const weatherEnv = loadWeatherEnv(env);

    if (method === "POST" && pathname === "/api/chat") {
      const body = await readBody();
      const messages = Array.isArray(body.messages) ? body.messages.filter(isChatTurn) : [];
      if (messages.length === 0) return json(400, { error: "messages is required" });

      try {
        const accounts = await loadGoogleAccounts(env);
        const result = await runChat(llmEnv, env, accounts, repo, coachPlanEnv, weatherEnv, messages);
        return json(200, result);
      } catch (error) {
        if (error instanceof Error && error.message === "both_unavailable") {
          return json(502, { error: "both_unavailable" });
        }
        throw error;
      }
    }

    if (method === "GET" && pathname === "/api/coachplan/upcoming") {
      if (!isCoachPlanConfigured(coachPlanEnv)) return json(200, { configured: false, sessions: [], matches: [] });
      try {
        const [sessions, matches] = await Promise.all([getUpcomingSessions(coachPlanEnv), getUpcomingMatches(coachPlanEnv)]);
        return json(200, { configured: true, sessions, matches });
      } catch (error) {
        console.error("[coachplan] upcoming query failed:", error);
        return json(502, { error: "Couldn't reach CoachPlan right now." });
      }
    }

    if (method === "GET" && pathname === "/api/weather/today") {
      const briefing = await fetchWeatherBriefing(weatherEnv);
      return json(200, briefing ?? null);
    }

    if (method === "POST" && pathname === "/api/capture/transcribe") {
      if (!llmEnv.openaiApiKey) {
        return json(503, { error: "Voice capture isn't configured yet — OPENAI_API_KEY is missing." });
      }
      const body = await readBody();
      const audioBase64 = typeof body.audio === "string" ? body.audio : "";
      const mimeType = typeof body.mimeType === "string" ? body.mimeType : "audio/webm";
      if (!audioBase64) return json(400, { error: "No audio was recorded." });
      if (audioBase64.length > MAX_AUDIO_BASE64_CHARS) return json(413, { error: "Recording is too long." });

      try {
        const buffer = Buffer.from(audioBase64, "base64");
        const text = await transcribeAudio(llmEnv.openaiApiKey, buffer, mimeType);
        return json(200, { text: text.trim() });
      } catch (error) {
        console.error("[capture] transcription failed:", error);
        return json(500, { error: "Couldn't transcribe that recording. Try again." });
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

    // Only ever called after the user explicitly confirms a proposal Chat
    // showed them (see server/llm/chat.ts's EVENT_PROPOSAL_INSTRUCTION) —
    // this route has no confirmation step of its own, it trusts the
    // frontend already got a yes.
    if (method === "POST" && pathname === "/api/calendar/create-event") {
      const body = await readBody();
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const date = typeof body.date === "string" ? body.date : "";
      const accountEmail = typeof body.account === "string" ? body.account : "";
      const startTime = typeof body.startTime === "string" ? body.startTime : undefined;
      const endTime = typeof body.endTime === "string" ? body.endTime : undefined;
      if (!title || !date || !accountEmail) return json(400, { error: "title, date, and account are required" });

      try {
        assertWritableAccount(accountEmail);
      } catch (error) {
        if (error instanceof CalendarAccountNotWritableError) return json(403, { error: error.message });
        throw error;
      }

      const accounts = await loadGoogleAccounts(env);
      const account = accounts.find((a) => a.email === accountEmail);
      if (!account) return json(404, { error: `${accountEmail} isn't a connected account.` });

      try {
        const created = await createEvent(account, { title, date, startTime, endTime });
        return json(200, created);
      } catch (error) {
        if (error instanceof GoogleReconnectRequiredError) return json(409, { error: "reconnect_required" });
        if (error instanceof GoogleNotConnectedError) return json(409, { error: "not_connected" });
        throw error;
      }
    }

    // Explicit "Scan calendar" capture mode only — never triggered by a
    // normal photo capture. Reads the photo, never writes anything; the
    // actual calendar write only happens after the user reviews and
    // approves in /api/calendar/photo-scan/create below.
    if (method === "POST" && pathname === "/api/calendar/photo-scan/extract") {
      const body = await readBody();
      const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
      const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
      if (!imageBase64) return json(400, { error: "No photo was provided." });
      if (imageBase64.length > MAX_PHOTO_BASE64_CHARS) return json(413, { error: "That photo is too large." });
      if (!VALID_IMAGE_MIME_TYPES.has(mimeType)) return json(400, { error: "Unsupported image type." });

      let extraction;
      try {
        extraction = await extractCalendarPhoto(llmEnv, imageBase64, mimeType as "image/jpeg" | "image/png" | "image/webp");
      } catch (error) {
        console.error("[calendarPhoto] extraction failed:", error);
        return json(502, { error: "Couldn't read that photo — try again, or a clearer shot of the page." });
      }

      const accounts = await loadGoogleAccounts(env);
      const account = accounts.find((a) => a.email === WRITABLE_CALENDAR_ACCOUNT);
      if (!account) return json(409, { error: "not_connected" });

      const range = extractionDateRange(extraction);
      let existingEvents: CalendarEventRecord[] = [];
      if (range) {
        try {
          existingEvents = await listEvents(account, {
            start: new Date(`${range.start}T00:00:00`),
            end: new Date(`${range.end}T23:59:59`),
          });
        } catch (error) {
          if (error instanceof GoogleReconnectRequiredError) return json(409, { error: "reconnect_required" });
          throw error;
        }
      }

      const reviewItems = buildReviewItems(extraction, existingEvents);
      return json(200, { monthYear: extraction.monthYear, items: reviewItems });
    }

    if (method === "POST" && pathname === "/api/calendar/photo-scan/create") {
      const body = await readBody();
      const items = Array.isArray(body.items) ? body.items.filter(isApprovedPhotoItem) : [];
      if (items.length === 0) return json(400, { error: "No approved items were provided." });

      const accounts = await loadGoogleAccounts(env);
      const account = accounts.find((a) => a.email === WRITABLE_CALENDAR_ACCOUNT);
      if (!account) return json(409, { error: "not_connected" });

      const results = await Promise.all(
        items.map(async (item) => ({ item, result: await createEventsForApprovedItem(account, item) }))
      );
      return json(200, {
        results: results.map(({ item, result }) => ({ title: item.title, date: item.date, ...result })),
      });
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
      const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 100) : 50;
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

    if (method === "POST" && pathname === "/api/nudges/snooze") {
      const body = await readBody();
      const taskId = typeof body.taskId === "string" ? body.taskId : "";
      if (!taskId) return json(400, { error: "taskId is required" });
      await snoozeNudge(env, taskId);
      return json(200, { ok: true });
    }

    if (method === "GET" && pathname === "/api/digest/weekly/settings") {
      return json(200, { triggerDay: await getDigestTriggerDay(env) });
    }

    if (method === "POST" && pathname === "/api/digest/weekly/settings") {
      const body = await readBody();
      const triggerDay: DigestTriggerDay = body.triggerDay === "monday" ? "monday" : "sunday";
      await setDigestTriggerDay(env, triggerDay);
      return json(200, { triggerDay });
    }

    // Read-only presence checks for the Permissions & Trust settings
    // section — never used to gate any actual capability, just to show
    // the user an honest picture of what's currently configured.
    if (method === "GET" && pathname === "/api/settings/integration-status") {
      return json(200, {
        notion: Boolean(notionEnv.token),
        anthropic: Boolean(llmEnv.anthropicApiKey),
        openai: Boolean(llmEnv.openaiApiKey),
        coachplan: isCoachPlanConfigured(coachPlanEnv),
        ntfy: Boolean(loadNtfyEnv(env).topic),
      });
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

    if (method === "GET" && pathname === "/api/digest/weekly") {
      const accounts = await loadGoogleAccounts(env);
      return json(200, await checkWeeklyDigest(env, llmEnv, loadNtfyEnv(env), accounts, repo));
    }

    if (method === "POST" && pathname === "/api/digest/weekly/generate") {
      const accounts = await loadGoogleAccounts(env);
      return json(200, await generateWeeklyDigestNow(env, llmEnv, loadNtfyEnv(env), accounts, repo));
    }

    if (method === "GET" && pathname === "/api/recurring/check") {
      return json(200, await checkRecurringTasks(env, llmEnv, repo));
    }

    if (method === "POST" && pathname === "/api/recurring/scan") {
      return json(200, await scanForRecurringPatterns(env, llmEnv, repo));
    }

    if (method === "GET" && pathname === "/api/recurring/suggestions") {
      return json(200, await listPendingSuggestions(env));
    }

    const acceptMatch = pathname.match(/^\/api\/recurring\/suggestions\/([^/]+)\/accept$/);
    if (method === "POST" && acceptMatch) {
      await acceptSuggestion(env, repo, acceptMatch[1]);
      return json(200, { ok: true });
    }

    const dismissMatch = pathname.match(/^\/api\/recurring\/suggestions\/([^/]+)\/dismiss$/);
    if (method === "POST" && dismissMatch) {
      await dismissSuggestion(env, dismissMatch[1]);
      return json(200, { ok: true });
    }

    if (method === "GET" && pathname === "/api/project-groupings/check") {
      return json(200, await checkProjectGroupings(env, llmEnv, repo));
    }

    if (method === "POST" && pathname === "/api/project-groupings/scan") {
      return json(200, await scanForProjectGroupings(env, llmEnv, repo));
    }

    if (method === "GET" && pathname === "/api/project-groupings/suggestions") {
      return json(200, await listPendingGroupings(env));
    }

    const groupingAcceptMatch = pathname.match(/^\/api\/project-groupings\/suggestions\/([^/]+)\/accept$/);
    if (method === "POST" && groupingAcceptMatch) {
      await acceptGrouping(env, repo, groupingAcceptMatch[1]);
      return json(200, { ok: true });
    }

    const groupingDismissMatch = pathname.match(/^\/api\/project-groupings\/suggestions\/([^/]+)\/dismiss$/);
    if (method === "POST" && groupingDismissMatch) {
      await dismissGrouping(env, groupingDismissMatch[1]);
      return json(200, { ok: true });
    }

    if (method === "GET" && pathname === "/api/freelance/clients") {
      const [tasks, notes] = await Promise.all([repo.listTasks(), repo.listNotes()]);
      const summaries = FREELANCE_CLIENTS.map((name) => ({
        name,
        openTaskCount: tasks.filter((t) => t.client === name && !t.done).length,
        noteCount: notes.filter((n) => n.client === name).length,
      }));
      return json(200, summaries);
    }

    const clientMatch = pathname.match(/^\/api\/freelance\/clients\/([^/]+)$/);
    if (method === "GET" && clientMatch) {
      const client = decodeURIComponent(clientMatch[1]);
      if (!isFreelanceClient(client)) return json(404, { error: "Unknown client" });

      const [tasks, notes] = await Promise.all([repo.listTasks(undefined, client), repo.listNotes(undefined, client)]);
      const emails = await searchEmailsByTerms(env, emailSearchTermsFor(client), 10);
      return json(200, { client, tasks, notes, emails });
    }

    if (method === "POST" && pathname === "/api/capture") {
      const body = await readBody();
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const source = body.source === "share-target" ? "share-target" : "manual";
      if (!text) return json(400, { error: "text is required" });

      const items = await splitAndClassifyCapture(llmEnv, text);

      // Common case: one item, no review needed — files immediately, exact
      // same shape/behavior as before this feature existed. Uses the
      // original text verbatim (not the model's per-item text, which is
      // only meaningfully different when there's more than one item).
      if (items.length === 1) {
        const inbox = await repo.createInboxPage(text, source);
        const filed = await repo.fileClassifiedItem(inbox.id, text, { type: items[0].type, project: items[0].project });
        return json(200, { inbox, filed });
      }

      // Multiple items detected — nothing is written yet. The frontend
      // shows these for review/edit and calls /api/capture/multi once
      // confirmed.
      return json(200, { multiple: true, items });
    }

    if (method === "POST" && pathname === "/api/capture/multi") {
      const body = await readBody();
      const source = body.source === "share-target" ? "share-target" : "manual";
      const items = Array.isArray(body.items) ? body.items.filter(isCaptureItem) : [];
      if (items.length === 0) return json(400, { error: "items is required" });

      const filed = [];
      for (const item of items) {
        const inbox = await repo.createInboxPage(item.text, source);
        const filedItem = await repo.fileClassifiedItem(inbox.id, item.text, { type: item.type, project: item.project });
        filed.push({ inbox, filed: filedItem });
      }
      return json(200, { results: filed });
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
    if (method === "DELETE" && noteMatch) {
      await repo.archiveNote(noteMatch[1]);
      return json(200, { ok: true });
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (method === "DELETE" && projectMatch) {
      try {
        const result = await repo.deleteProject(projectMatch[1]);
        return json(200, { ok: true, ...result });
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "Couldn't delete that project." });
      }
    }

    return json(404, { error: "not found" });
  } catch (error) {
    console.error(error);
    return json(500, { error: error instanceof Error ? error.message : "internal error" });
  }
}

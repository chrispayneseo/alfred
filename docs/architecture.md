# Architecture

How Alfred is laid out and how its main pieces fit together. For setup see the [README](../README.md); for deployment see [deployment.md](deployment.md).

## Folder structure

- `src/screens` — the five top-level screens (Today/Chat/Capture/Browse plus Settings, reached via the gear icon rather than the tab bar)
- `src/components` — shared UI (tab bar, FAB, offline banner, model tag, `LockScreen`, `AppLockSettings`, `DataControls`, `GoogleAccountsSettings`, `AccountTag`)
- `src/hooks/useLockGate.ts` — cold-start + re-lock-on-resume logic for the app lock
- `src/mocks` — stand-in data still used by Today's tasks/notes; everything else uses the `src/integrations/*` API clients
- `src/lib` — routing/storage helpers not tied to a specific vendor, the client-only lock primitives (`webauthn.ts`, `pin.ts`, `lock.ts`), and `accountColor.ts` (stable color assignment per connected Google account)
- `src/integrations/notion` — frontend fetch wrappers around the `/api/{capture,tasks,notes,projects}` routes
- `src/integrations/llm` — frontend fetch wrapper around `/api/chat`
- `src/integrations/google-calendar` — frontend fetch wrappers around `/api/calendar/*` and `/api/google/status`
- `src/integrations/google-accounts` — frontend fetch wrappers around `/api/google/accounts` (list, disconnect) and the connect/reconnect URLs
- `src/integrations/gmail` — frontend fetch wrappers around `/api/gmail/*` (status, sync, scan, flagged list)
- `src/integrations/nudges` — frontend fetch wrapper around `/api/nudges/check`
- `src/integrations/settings` — frontend fetch wrappers around `/api/settings/{export,wipe}`
- `server/notion` — Notion SDK client, query layer, rule-based classifier (now a fallback), workspace setup script, `searchTasksAndNotes` for Q&A grounding, `listOverdueTasks` for nudges
- `server/llm` — routing function (`router.ts`, with tests), Anthropic/OpenAI client wrappers (chat + single-turn `*Complete` variants), `routedComplete.ts` (Step 3's routing/fallback reused for structured tasks), chat fallback orchestration, real capture classifier, `emailScan.ts` (action-item classification + draft generation, now multi-account aware), `nudgeMessage.ts` (overdue-task nudge phrasing), `queryTerms.ts` (derives a Gmail search query from a chat message), `notionContext.ts` / `emailContext.ts` / `calendarContext.ts` (Q&A grounding, all merging across every connected Google account)
- `server/google` — OAuth flow (`oauth.ts`, stateless signed-state CSRF, `revokeToken`, `login_hint` support), authenticated client factory (`client.ts`), typed error hierarchy (`errors.ts`), multi-account storage + per-account health (`accounts.ts` — the one place the `google_accounts` table is read/written), calendar service (`calendar.ts`, with `listEventsAllAccounts` merging across accounts), Gmail service (`gmail.ts` — the safety-critical file, see [Gmail](gmail.md)), sync job (`gmailSync.ts`, DB-backed status), and the Gmail metadata cache (`gmailStore.ts`, Postgres)
- `server/db.ts` — the shared Postgres client (`@neondatabase/serverless`'s `sql`) and `ensureSchema()`, the one place the whole schema is defined
- `server/notify` — `notify(topic, message)`, a reusable ntfy.sh push sender (`ntfy.ts`) plus its env loader; meant to be reused for the daily briefing later
- `server/nudges` — nudge orchestration (`check.ts` — the one entry point, `runNudgeCheck(dbEnv, llmEnv, ntfyEnv, repo)`, written to be callable from a real scheduler later) and the push-throttle store (`nudgeStore.ts`, Postgres)
- `server/settings` — `export.ts` (`buildExport`, assembles the data-export payload) and `wipe.ts` (`wipeEverything`, the disconnect flow)
- `server/handleApiRequest.ts` — the one place all `/api/*` routing/business logic lives, transport-agnostic (see [Deployment](deployment.md))
- `server/apiPlugin.ts` — thin Vite dev-server adapter over `handleApiRequest.ts` (local `npm run dev`)
- `api/index.ts` — thin Vercel Node.js serverless adapter over the same `handleApiRequest.ts` (production), reached via an explicit rewrite rather than file-based routing (see [Deployment](deployment.md))
- `vercel.json` — function `maxDuration`, the `/api/*` rewrite, and the SPA fallback rewrite `BrowserRouter` needs
- `src/sw.ts` — custom service worker (offline shell caching + Web Share Target handling)

## Notion workspace shape

- **Inbox** — every capture lands here first (`Status`: Untriaged/Triaged, `Captured Via`: manual/share-target)
- **Tasks** / **Notes** — classified items, each with a `Project` relation and a `From Inbox` relation back to the originating capture
- **Projects** — Job, Freelance, Personal, Football Coaching, Unsorted (catch-all for low-confidence classifications); Personal has a nested "Genealogy" child page reserved for later
- **Journal** — structure only, not used yet

## Chat routing

### Dell-first chat gateway (staged integration)

The Chat screen now contacts `https://<your-dell-node>.<tailnet>.ts.net/v1/gateway` first. That private address requires the user's device to be connected to the same Tailscale network. The Dell's 1.7B model triages longer requests; its 4B model answers locally where appropriate. Every cloud escalation shows an approval card first. General specialist requests go to `/api/chat/plain` only after approval; that path receives only the user's exact current prompt and does not fetch connected account data or Dell memory. The Dell can choose the route but cannot compose or expand the text sent to cloud. The user can choose a local answer instead. Connected account requests show a separate approval card; if approved, the existing `/api/chat` path may retrieve relevant connected data and the user's opted-in current location, as disclosed on the card, and send them to Claude or ChatGPT, preserving calendar and other proposal features. Dell memory is never added to those cloud requests. If the Dell is unavailable, Chat reports the error and does not silently route around it.

The Dell API must bind to host loopback and be published through Tailscale Serve. Configure `ALFRED_TAILSCALE_USER` and `ALFRED_WEB_ORIGIN=https://<your-app>.vercel.app` on the Dell so its browser route accepts only the chosen tailnet identity and web origin. The private API key stays off the browser.

Settings → Data Management includes Dell memory search, add, and per-entry deletion. These memories are separate from the Vercel data export and disconnect action; cloud handoffs never include them.

`server/llm/router.ts` is a pure, dependency-free function — keyword match on the message text decides Claude vs ChatGPT. If the chosen model's API call fails for any reason, `server/llm/chat.ts` retries the same request on the other model and reports which model actually answered (`ChatMessage.model`) plus a `note` when a fallback happened. If both fail, the Chat screen shows a distinct "assistant unavailable" message rather than a silent failure; if the browser is offline, it shows that instead without attempting the call.

## Google Calendar

Read + write on events only (`calendar.events` — not calendar settings/ACLs), one or more accounts (see [Multiple Google accounts](#multiple-google-accounts)), OAuth 2.0 with `access_type: offline` + `prompt: consent` so a refresh token is always issued. `server/google/calendar.ts` is the shared, standalone service module: `listEvents(env, range)` for one account, plus `listEventsAllAccounts(accounts, range)` (and `getTodayEventsAllAccounts`/`getTomorrowEventsAllAccounts` convenience wrappers) that merge every connected account's events, sorted by start time and tagged with `accountEmail`; `createEvent(env, input)` creates a single event. A missing or revoked token (or one that predates the `calendar.events` upgrade and lacks write access) surfaces as a typed `GoogleNotConnectedError` / `GoogleReconnectRequiredError` rather than a generic failure, so both the Today screen and Chat can show an honest "reconnect" state instead of crashing or guessing — and with multiple accounts, one account needing reconnection doesn't hide the other's still-working events (see [Multiple Google accounts](#multiple-google-accounts)).

**Chat can create events, but only with your explicit confirmation.** Chat has no general tool-calling loop — this is a single narrow capability. When a request looks like it's asking for a calendar event, the model is instructed to *propose* one (title/date/time, defaulting to the your designated writable calendar account (`WRITABLE_CALENDAR_ACCOUNT` in `server/google/calendarWriteGuard.ts`) account unless the other is named) rather than create it: it emits a `[[CALENDAR_EVENT_PROPOSAL]]` JSON block on a line by itself, which `server/llm/chat.ts` parses out of the reply (never shown to the user as raw text) into a structured `eventProposal` on the API response. The frontend renders that as a card with explicit **Add to calendar** / **Cancel** buttons — nothing is written to your calendar until you tap Add, which calls `POST /api/calendar/create-event`. `server/llm/chat.ts` also always injects the real current date (in `Europe/London`, `DEFAULT_TIME_ZONE` from `calendar.ts`) into the model's context, so "tomorrow"/"next Friday" resolve correctly instead of guessing from training data.

## Multiple Google accounts

**Storage.** The `google_accounts` Postgres table holds `{email, refresh_token, health, connected_at}` per connected account (`server/google/accounts.ts`), ordered by `connected_at` — connection order, which the UI uses for stable color assignment. Originally a `.env`-JSON array; moved to Postgres as part of [Deployment](deployment.md) since env vars are read-only at runtime on Vercel.

**Connecting.** "Connect calendar" (Today, when nothing's connected) and "Connect another Google account" (Settings) hit the exact same `/api/google/auth/start` → OAuth → `/api/google/oauth/callback` flow. The callback fetches the account's real email via Google's `userinfo.email` scope (the narrowest scope Google offers for this — no Calendar/Gmail access of its own) and upserts it into `google_accounts` by email, so reconnecting an already-connected account refreshes its token in place rather than creating a duplicate or reordering the list. Reconnecting a *specific* broken account from Settings passes `?email=` through to Google's `login_hint`, pre-selecting that account in Google's picker.

**Attribution.** Each connected account is identified by its real Gmail address — fetched automatically, not something you name yourself. Once more than one account is connected, merged calendar events and flagged emails show a small colored dot + short label (`src/components/AccountTag.tsx`, mirroring the existing `ModelTag` pattern used for Claude/ChatGPT) — colors are assigned by connection order (`src/lib/accountColor.ts`), not shown at all when there's only one account, to stay out of the way for the common case.

**Partial failure.** If one account's token needs reconnecting while another still works, Today/Chat/Gmail scanning keep showing what's available from the working account(s) rather than blocking everything — the account's `health` column (`ok` / `reconnect_required`, updated wherever a Google call actually runs) is what Settings reads to show each account's own status without making a live API call just to render the page. Only when *every* connected account fails does the UI fall back to the familiar single "reconnect" screen.

**Disconnecting.** Settings can disconnect one account independently of any others — revokes that account's token with Google directly (`oauth.ts`'s `revokeToken`), removes its row from `google_accounts`, and clears just that account's cached emails (`clearEmailsForAccount`). This is the same "revoke, don't touch Notion" pattern as the Step 7 full wipe, scoped to one account; the full "delete everything / disconnect" in Settings still revokes and removes every connected account at once.

## Nudges

**Scope.** v1 covers overdue Tasks only: a Notion Task with `Status: Open` and a `Due Date` before today. `NotionRepo.listOverdueTasks()` queries this directly with a compound Notion filter rather than fetching and filtering every task client-side.

**No dismissed state.** There's no "dismiss" action or stored per-task acknowledgement — a nudge is derived live from Notion's current status every time the check runs. Mark the task Done in Notion and its nudge simply stops showing up on the next check, in-app or push.

**Generation.** `server/nudges/check.ts`'s `runNudgeCheck(dbEnv, llmEnv, ntfyEnv, repo)` is the one entry point: it queries overdue tasks, phrases a short, calm reminder for each with the routed model (`server/llm/nudgeMessage.ts`, reusing Step 3's Claude/ChatGPT routing and fallback via `routedComplete.ts`, on Haiku rather than Chat's Opus — same cost reasoning as the email classifier), and pushes each via `notify()`. It's a plain async function with no framework-specific triggering baked in, so a real scheduler can call it exactly this way later; for v1 it's triggered by the Today screen on load.

**Push delivery.** `server/notify/ntfy.ts` exports `notify(topic, message)` — one `POST` to `https://ntfy.sh/<topic>`, no server URL or account needed beyond picking a topic name. It's intentionally generic (not nudge-specific) so the daily briefing can reuse it later. Delivery degrades gracefully: with `NTFY_TOPIC` unset, nudges still show in-app, they just don't push.

**Push throttling.** Since nudges have no dismissed state, the in-app list is always live — but that also means opening Today five times in a day would otherwise fire five phone pushes for the same still-overdue task. The `pushed_nudges` Postgres table (`server/nudges/nudgeStore.ts`) records only "was this task's push already sent today" — it throttles the *push*, not the in-app display, and resets naturally at midnight since it's keyed by date.

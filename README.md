# Alfred

A proactive personal assistant PWA — captures, organizes, and briefs, using Claude/ChatGPT as interchangeable workers and Notion as the single source of truth.

## Status

All 8 planned steps are complete (multi-account Google, above, was the last of them) — this pass is the deployment that follows: Alfred now runs on Vercel with a real Postgres database (Neon), not just `npm run dev` on one machine. The backend was a Vite dev-server plugin that only ran under `vite dev`; it's now split into a shared, transport-agnostic handler (`server/handleApiRequest.ts`) driven by two thin adapters — the same dev plugin locally, a Vercel serverless function in production — and everything that used to live in local SQLite or a hand-written `.env` file (OAuth tokens, the Gmail cache, nudge history, background-job status) now lives in Postgres, since none of that survives a stateless, ephemeral serverless filesystem. See [Deployment](#deployment) below for the full architecture.

**Alfred never sends email.** Only `gmail.readonly` and `gmail.compose` are requested — never `gmail.send` — and the code only ever calls `gmail.users.drafts.create`; nothing in `server/` calls `messages.send` or `drafts.send`. See [Gmail](#gmail) below for the full safety model.

## Stack

React + Vite + TypeScript + Tailwind CSS v4, installable PWA (manifest + service worker + Web Share Target). The backend logic lives in one shared handler (`server/handleApiRequest.ts`) driven by two adapters: `server/apiPlugin.ts` (a Vite dev-server plugin, local `npm run dev`) and `api/[...path].ts` (a Vercel Node.js serverless function, production) — so the Notion/Anthropic/OpenAI/Google credentials never ship to the browser and CORS isn't an issue, in both environments. Persistent state (Google OAuth tokens, the Gmail metadata cache, nudge push-history, sync/scan job status) lives in Postgres (Neon), the same database for local dev and production.

## Develop

```bash
npm install
cp .env.example .env   # fill in the credentials listed below
npm run notion:setup   # one-off: provisions Inbox/Tasks/Notes/Journal/Projects, writes DB IDs into .env
npm run dev
```

See `.env.example` for the full list of required variables. Notes on the trickier ones:
- `DATABASE_URL` — a Postgres connection string. The dev instructions above assume you've already run through [Deployment](#deployment) once (`vercel link` + `vercel install neon`), which writes this into `.env.local` automatically; Vite's `loadEnv()` picks up `.env.local` alongside `.env` with no extra config. Local dev and production share this one database by design (see Deployment) — a local test of Settings' wipe/disconnect really does revoke your production Google grant and clear your production Gmail cache.
- `OPENAI_MODEL` is optional, defaults to `gpt-5.6-terra`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` come from a Google Cloud Console OAuth client (Web application type). In the Cloud Console you need both the **Calendar API** and the **Gmail API** enabled for the project (Library → search each → Enable), and the OAuth consent screen needs the `calendar.readonly`, `gmail.readonly`, `gmail.compose`, and `userinfo.email` scopes, with every Google account you plan to connect added as a test user (the project stays in "Testing" mode, so each account needs to be added explicitly — see [Multiple Google accounts](#multiple-google-accounts))
- `GOOGLE_REDIRECT_URI` — leave unset locally (defaults to `http://localhost:5173/api/google/oauth/callback`); set explicitly in Vercel for Production only (see Deployment). Whichever URI is active must also be in the OAuth client's Authorized redirect URIs list in Cloud Console.
- Connected Google accounts live in Postgres now, not `.env` — open the app, go to Today (or Settings → Google accounts), and click "Connect calendar" / "Connect a Google account". Repeat for a second account via Settings → "Connect another Google account".
- `NTFY_TOPIC` — pick your own unguessable topic name (ntfy.sh topics aren't private unless you add auth) and subscribe to `https://ntfy.sh/<topic>` in the ntfy app or web UI to actually receive the pushes; leave blank to skip push delivery and still see nudges in-app only

Run `npm test` to run the standalone router unit tests (`server/llm/router.test.ts`).

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
- `src/integrations/{supabase,anthropic,openai}` — empty stubs reserved for later steps (the actual Anthropic/OpenAI/Google calls live server-side, never in the browser)
- `server/notion` — Notion SDK client, query layer, rule-based classifier (now a fallback), workspace setup script, `searchTasksAndNotes` for Q&A grounding, `listOverdueTasks` for nudges
- `server/llm` — routing function (`router.ts`, with tests), Anthropic/OpenAI client wrappers (chat + single-turn `*Complete` variants), `routedComplete.ts` (Step 3's routing/fallback reused for structured tasks), chat fallback orchestration, real capture classifier, `emailScan.ts` (action-item classification + draft generation, now multi-account aware), `nudgeMessage.ts` (overdue-task nudge phrasing), `queryTerms.ts` (derives a Gmail search query from a chat message), `notionContext.ts` / `emailContext.ts` / `calendarContext.ts` (Q&A grounding, all merging across every connected Google account)
- `server/google` — OAuth flow (`oauth.ts`, stateless signed-state CSRF, `revokeToken`, `login_hint` support), authenticated client factory (`client.ts`), typed error hierarchy (`errors.ts`), multi-account storage + per-account health (`accounts.ts` — the one place the `google_accounts` table is read/written), calendar service (`calendar.ts`, with `listEventsAllAccounts` merging across accounts), Gmail service (`gmail.ts` — the safety-critical file, see [Gmail](#gmail)), sync job (`gmailSync.ts`, DB-backed status), and the Gmail metadata cache (`gmailStore.ts`, Postgres)
- `server/db.ts` — the shared Postgres client (`@neondatabase/serverless`'s `sql`) and `ensureSchema()`, the one place the whole schema is defined
- `server/notify` — `notify(topic, message)`, a reusable ntfy.sh push sender (`ntfy.ts`) plus its env loader; meant to be reused for the daily briefing later
- `server/nudges` — nudge orchestration (`check.ts` — the one entry point, `runNudgeCheck(dbEnv, llmEnv, ntfyEnv, repo)`, written to be callable from a real scheduler later) and the push-throttle store (`nudgeStore.ts`, Postgres)
- `server/settings` — `export.ts` (`buildExport`, assembles the data-export payload) and `wipe.ts` (`wipeEverything`, the disconnect flow)
- `server/handleApiRequest.ts` — the one place all `/api/*` routing/business logic lives, transport-agnostic (see [Deployment](#deployment))
- `server/apiPlugin.ts` — thin Vite dev-server adapter over `handleApiRequest.ts` (local `npm run dev`)
- `api/[...path].ts` — thin Vercel Node.js serverless adapter over the same `handleApiRequest.ts` (production)
- `vercel.json` — function `maxDuration` + the SPA fallback rewrite `BrowserRouter` needs
- `src/sw.ts` — custom service worker (offline shell caching + Web Share Target handling)

## Notion workspace shape

- **Inbox** — every capture lands here first (`Status`: Untriaged/Triaged, `Captured Via`: manual/share-target)
- **Tasks** / **Notes** — classified items, each with a `Project` relation and a `From Inbox` relation back to the originating capture
- **Projects** — Job, Freelance, Personal, Football Coaching, Unsorted (catch-all for low-confidence classifications); Personal has a nested "Genealogy" child page reserved for later
- **Journal** — structure only, not used yet

## Chat routing

`server/llm/router.ts` is a pure, dependency-free function — keyword match on the message text decides Claude vs ChatGPT. If the chosen model's API call fails for any reason, `server/llm/chat.ts` retries the same request on the other model and reports which model actually answered (`ChatMessage.model`) plus a `note` when a fallback happened. If both fail, the Chat screen shows a distinct "assistant unavailable" message rather than a silent failure; if the browser is offline, it shows that instead without attempting the call.

## Google Calendar

Read-only (`calendar.readonly`), one or more accounts (see [Multiple Google accounts](#multiple-google-accounts)), OAuth 2.0 with `access_type: offline` + `prompt: consent` so a refresh token is always issued. `server/google/calendar.ts` is the shared, standalone service module: `listEvents(env, range)` for one account, plus `listEventsAllAccounts(accounts, range)` (and `getTodayEventsAllAccounts`/`getTomorrowEventsAllAccounts` convenience wrappers) that merge every connected account's events, sorted by start time and tagged with `accountEmail`. A missing or revoked token surfaces as a typed `GoogleNotConnectedError` / `GoogleReconnectRequiredError` rather than a generic failure, so both the Today screen and Chat can show an honest "reconnect" state instead of crashing or guessing — and with multiple accounts, one account needing reconnection doesn't hide the other's still-working events (see [Multiple Google accounts](#multiple-google-accounts)).

## Gmail

**Scopes and the send guarantee.** Alfred requests exactly `gmail.readonly` and `gmail.compose` — never `gmail.send`, never `gmail.modify` — on every connected account. These are added to the same OAuth flow (`server/google/oauth.ts`); reconnecting re-runs consent for the union of scopes. Google's `gmail.compose` grant is technically broad enough to send mail (it's described as "manage drafts and send emails"), so the "Alfred never sends" guarantee here is enforced in code, not by the grant: `server/google/gmail.ts` — the one file that talks to the Gmail API — carries a top-of-file safety-invariant comment, and every write goes through `gmail.users.drafts.create` only. Nothing in `server/` calls `messages.send` or `drafts.send`; this is grep-verified (`grep -rn "\.send(\|drafts\.send\|messages\.send" server/`) and worth re-running after any change to the Gmail code path.

**Sync.** `server/google/gmailSync.ts` loops every connected account, backfilling each inbox (default 30 days, configurable) in paced batches of 10 (200ms apart) so a large backfill doesn't hammer Gmail's rate limits, storing only metadata — sender, subject, date, snippet, threadId, and which account it's from — in Postgres (`server/google/gmailStore.ts`, the `gmail_emails` table; rows are keyed by `(accountEmail, id)` since Gmail message ids are only unique within one account's mailbox). Bodies are fetched on-demand, never bulk-stored. A progress indicator on the Today screen polls a status endpoint, reading job progress from the `sync_job` table rather than in-process memory — see [Deployment](#deployment) for why. One account failing partway through doesn't stop the others from syncing.

**Scan.** A separate, user-triggered "Scan" step (`server/llm/emailScan.ts`) runs unscanned emails from every connected account through the routed model (the same Claude/ChatGPT routing and fallback from Step 3, generalized into `routedComplete.ts` for single-turn structured tasks) to flag whether each needs a reply, has a deadline, and which Notion project it belongs to — the classifier is never told which account an email came from, so a work-relevant email files under Job even if it landed in the personal inbox, and vice versa. Actionable emails are filed into Notion (Inbox, then Tasks or Notes) with a link back to the Gmail thread; emails needing a reply get a real Gmail **draft** — never sent — created via the *same account the email arrived on*, threaded correctly via `In-Reply-To`/`References`/`threadId`, left for you to review and send yourself.

**Q&A grounding.** Chat's retrieval spans Notion, calendar, and email together (`server/llm/notionContext.ts`, `server/llm/calendarContext.ts`, `server/llm/emailContext.ts`): a question that looks like it needs email or calendar context triggers a live search across every connected account plus on-demand body fetch for the top email results, merged and sorted before being handed to the model. The search query is derived from the chat message by stripping stopwords and punctuation (`server/llm/queryTerms.ts`) — Gmail's search ANDs terms by default, so leftover words like "check" or "email" are enough to zero out real results, which is why the stopword list is aggressive.

**Errors.** Three distinct typed errors (`server/google/errors.ts`) drive three distinct UI states: `GoogleNotConnectedError` (nothing connected — show "Connect Gmail"), `GoogleReconnectRequiredError` (one account's token expired/revoked/missing a scope — show "Reconnect" for that account), and `GoogleApiDisabledError` (the Gmail API itself isn't enabled in the Cloud project — a 403 that reconnecting can never fix, and affects every account identically since they share one Cloud project, so the UI links straight to Cloud Console instead of offering a reconnect button).

**Thread links.** `gmailThreadUrl(threadId, accountEmail)` builds `https://mail.google.com/mail/u/<email>/#inbox/<threadId>` rather than a hardcoded `/u/0/` — the browser's first-signed-in Google account has nothing to do with which of Alfred's connected accounts a thread actually belongs to, so a hardcoded index could silently open the wrong mailbox once more than one account is connected. Fixed as part of Step 8, both server-side (`emailScan.ts`'s Notion links) and client-side (`GmailFlagged.tsx`'s thread links).

**Privacy.** No email content leaves the app except in the LLM calls needed to classify or draft a reply (Anthropic/OpenAI, same as every other model call in the app).

## Multiple Google accounts

**Storage.** The `google_accounts` Postgres table holds `{email, refresh_token, health, connected_at}` per connected account (`server/google/accounts.ts`), ordered by `connected_at` — connection order, which the UI uses for stable color assignment. Originally a `.env`-JSON array; moved to Postgres as part of [Deployment](#deployment) since env vars are read-only at runtime on Vercel.

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

## Security (App Lock, export, wipe)

**App Lock.** WebAuthn (`src/lib/webauthn.ts`), verified entirely client-side — no server round-trip, no signature verification against a stored public key. This is a deliberate call, not an oversight: Alfred has no real multi-user backend to protect a remote identity against, so the threat model is someone picking up your already-unlocked device, not a network attacker forging a login. A successful `navigator.credentials.get()` can only happen via the OS's secure hardware actually matching your biometric — that's the property this design leans on. If biometrics aren't available or fail, `src/lib/pin.ts` is the fallback (a salted SHA-256 hash, never the PIN itself, stored via `crypto.subtle`) — the lock can't be turned on without a PIN set first, so there's no way to end up locked out with no way back in. `src/hooks/useLockGate.ts` locks on every cold start and re-locks after the app's been backgrounded for more than 60 seconds (`RELOCK_AFTER_MS` in `src/lib/lock.ts`) — a brief app-switch doesn't force a re-unlock, leaving it backgrounded for real does. WebAuthn requires a secure context; `localhost` counts locally, and Vercel serves HTTPS by default in production, so App Lock works the same in both places.

**Export.** `GET /api/settings/export` (`server/settings/export.ts`) packages everything Alfred caches locally — Gmail metadata cache, nudge push-throttle history — plus a summary of which integrations are connected and the exact Google scopes requested. It deliberately excludes Notion content (already the source of truth, exportable from Notion directly) and every credential (Notion token, Anthropic/OpenAI keys, Google client secret/refresh token) — those are Alfred's own operating credentials, not "your data." The Settings screen downloads it client-side as a single `alfred-export-<date>.json`.

**Wipe.** `POST /api/settings/wipe` (`server/settings/wipe.ts`) — scoped to exactly what the settings copy promises: revokes the Google OAuth grant with Google directly (`oauth.ts`'s `revokeToken`, not just deleting the local copy), clears the Gmail and nudge Postgres tables, and leaves Notion, the LLM API keys, and the ntfy topic untouched. Requires typing "delete" in the UI, and the server independently re-checks `confirm === "delete"` before doing anything. After a wipe the app looks freshly installed — Today's Schedule/Flagged sections fall back to their "not connected"/"sync your inbox" empty states automatically, since those already keyed off `GoogleNotConnectedError` and an empty cache.

**Scope review.** As of Step 8: `calendar.readonly`, `gmail.readonly`, `gmail.compose`, and `userinfo.email` (added in Step 8 — see [Multiple Google accounts](#multiple-google-accounts) for why) — all still the narrowest scopes available for what each feature does (no `calendar` write access, no `gmail.modify`, no `gmail.send`, and `userinfo.email` grants nothing beyond reading the connected account's own address). Nothing broader than necessary is requested, on any connected account.

## Deployment

**Why this exists.** Every backend feature in this app used to live in `server/apiPlugin.ts`, a Vite dev-server plugin — a hook that only runs under `vite dev`. `vite build`, what Vercel runs, produced a static-only bundle with zero backend. Deploying "as-is" would have shipped a live URL where every feature touching Notion/Google/the LLMs was broken. This section is that gap closed.

**Two adapters, one handler.** `server/handleApiRequest.ts` is the actual `/api/*` logic — the same big route-matching function that used to live directly inside `apiPlugin.ts`'s middleware closure, now transport-agnostic: it takes `{method, pathname, searchParams, readBody, env, backgroundTask}` and returns a JSON or redirect result, with no assumptions about Node's raw request/response or Vercel's. Two thin adapters drive it:
- `server/apiPlugin.ts` — unchanged local dev experience, still a Vite plugin, still `npm run dev`.
- `api/[...path].ts` — a Vercel Node.js serverless catch-all, all `/api/*` in production.

Each adapter supplies its own `env` source (Vite's `loadEnv()` locally, `process.env` on Vercel — every `loadXEnv()` function across `server/*/env.ts` takes this as a plain parameter now, rather than calling `loadEnv()` itself) and its own `backgroundTask()` (fire-and-forget locally, since the dev process stays alive for the life of `npm run dev`; Vercel's `waitUntil()` in production, which extends a function invocation past its initial response, up to `maxDuration`).

**Why Postgres.** Everything that used to persist locally — Google OAuth tokens (`.env`'s `GOOGLE_ACCOUNTS`), the Gmail metadata cache and nudge push-history (`node:sqlite`), and the Gmail sync/scan job status (an in-memory `let job`) — relied on either a writable local filesystem or a single long-lived process. Neither exists on Vercel: env vars are read-only at runtime, the filesystem is ephemeral, and a request can land on a different, stateless instance than the one before it. `server/db.ts` provisions Postgres via Neon (installed through Vercel's Storage/Marketplace tab — "Vercel Postgres" itself was discontinued in Dec 2024 in favor of Marketplace integrations) and exposes `ensureSchema()`, an idempotent `CREATE TABLE IF NOT EXISTS` set covering every table this app needs, run lazily on first access — same philosophy as the old SQLite `getDb()`, just pointed at a real network database. **One database serves both local dev and production** — deliberately, for parity, at the cost that a local test of Settings' wipe or per-account disconnect really does revoke your production Google grant and clear your production Gmail cache.

**Background jobs without a long-lived process.** Gmail sync and scan used to be a module-level `let job` mutated in place — fine for one persistent Node process, meaningless once a request can hit a different serverless instance than the one running the job. They're now singleton rows (`sync_job`, `scan_job`) claimed atomically (`UPDATE ... WHERE running = false RETURNING *`, so two concurrent "start" calls — or two different instances — can't both run the same job) and updated with atomic increments as they progress, so `GET .../status` polling always reads real, current progress regardless of which instance answers it. A staleness check (`updated_at` older than ~6 minutes while `running = true` ⇒ treat as failed) covers the case a serverless instance is recycled mid-job, since nothing else would ever clear a stuck row the way a local process restart used to for free.

**OAuth CSRF without server-side session state.** The `state` param used to be a single-use, in-memory random token (`let pendingState`) — doesn't survive the callback landing on a different instance than the one that generated the auth URL. It's now a stateless signed token: a timestamp + random nonce, HMAC-SHA256'd with the app's own `GOOGLE_CLIENT_SECRET` (already private, no other cryptographic use, so no new secret needed), verified with `crypto.timingSafeEqual` and a 10-minute freshness window. Trade-off, accepted deliberately: the old token was single-use and thus replay-proof; this one is valid for its whole freshness window, so a captured still-fresh state could in principle be replayed within it — acceptable for a single-user personal app, not equivalent security to the mechanism it replaces.

**Redirect URI.** `server/google/env.ts` defaults to the local `http://localhost:5173/api/google/oauth/callback` when `GOOGLE_REDIRECT_URI` is unset, and uses that env var explicitly in production. Preview deployments get a unique per-deploy URL that can't be pre-registered with Google, so OAuth simply doesn't work from previews — expected, not a bug to chase.

**Deploying.**
```bash
npm install -g vercel   # if not already installed
vercel link             # creates/links the Vercel project
vercel install neon --claim   # provisions Postgres, writes DATABASE_URL etc. into .env.local
git remote add origin <your-empty-github-repo-url>
git push -u origin main
```
Then, in the Vercel dashboard: import the project from GitHub (auto-detects Vite), set the environment variables listed in `.env.example` for Production (`DATABASE_URL` is already set from the `vercel install` step above; `GOOGLE_REDIRECT_URI` needs to be added explicitly, pointed at your production domain), add that same redirect URI to the Google Cloud Console OAuth client's Authorized redirect URIs list, and deploy. `ensureSchema()` creates every table on the first request that touches the database — no separate migration step.

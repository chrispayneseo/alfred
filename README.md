# Alfred

A proactive personal assistant PWA — captures, organizes, and briefs, using Claude/ChatGPT as interchangeable workers and Notion as the single source of truth.

## Status

Step 7 of 8: Security hardening — an app-level lock and settings-level data controls, since Alfred now holds email content, calendar data, and freelance client details. A gear icon on the Today screen opens Settings, with three things: App Lock (biometric via WebAuthn, PIN fallback, re-locks after the app's been backgrounded a while), Export my data (a single JSON download of everything Alfred caches locally, not Notion itself), and Delete everything / disconnect (revokes Google's OAuth grant and clears local caches, type-to-confirm, never touches Notion).

**Alfred never sends email.** Only `gmail.readonly` and `gmail.compose` are requested — never `gmail.send` — and the code only ever calls `gmail.users.drafts.create`; nothing in `server/` calls `messages.send` or `drafts.send`. See [Gmail](#gmail) below for the full safety model.

## Stack

React + Vite + TypeScript + Tailwind CSS v4, installable PWA (manifest + service worker + Web Share Target). A small API layer lives inside the Vite dev server (`server/apiPlugin.ts`) so the Notion/Anthropic/OpenAI/Google credentials never ship to the browser and CORS isn't an issue — this gets replaced by Supabase Edge Functions in a later step.

## Develop

```bash
npm install
cp .env.example .env   # fill in the credentials listed below
npm run notion:setup   # one-off: provisions Inbox/Tasks/Notes/Journal/Projects, writes DB IDs into .env
npm run dev
```

See `.env.example` for the full list of required variables. Notes on the trickier ones:
- `OPENAI_MODEL` is optional, defaults to `gpt-5.6-terra`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` come from a Google Cloud Console OAuth client (Web application type) — the authorized redirect URI must be exactly `http://localhost:5173/api/google/oauth/callback`. In the Cloud Console you need both the **Calendar API** and the **Gmail API** enabled for the project (Library → search each → Enable), and the OAuth consent screen needs the `calendar.readonly`, `gmail.readonly`, and `gmail.compose` scopes with your own account added as a test user
- `GOOGLE_REFRESH_TOKEN` is filled in automatically — open the app, go to Today, and click "Connect calendar" (this now also connects Gmail; if you connected before Step 5 you'll need to reconnect once so the new scopes are granted)
- `NTFY_TOPIC` — pick your own unguessable topic name (ntfy.sh topics aren't private unless you add auth) and subscribe to `https://ntfy.sh/<topic>` in the ntfy app or web UI to actually receive the pushes; leave blank to skip push delivery and still see nudges in-app only

Run `npm test` to run the standalone router unit tests (`server/llm/router.test.ts`).

## Folder structure

- `src/screens` — the five top-level screens (Today/Chat/Capture/Browse plus Settings, reached via the gear icon rather than the tab bar)
- `src/components` — shared UI (tab bar, FAB, offline banner, model tag, `LockScreen`, `AppLockSettings`, `DataControls`)
- `src/hooks/useLockGate.ts` — cold-start + re-lock-on-resume logic for the app lock
- `src/mocks` — stand-in data still used by Today's tasks/notes; everything else uses the `src/integrations/*` API clients
- `src/lib` — routing/storage helpers not tied to a specific vendor, plus the client-only lock primitives: `webauthn.ts` (biometric register/verify), `pin.ts` (salted-hash PIN fallback), `lock.ts` (enabled/configured state)
- `src/integrations/notion` — frontend fetch wrappers around the `/api/{capture,tasks,notes,projects}` routes
- `src/integrations/llm` — frontend fetch wrapper around `/api/chat`
- `src/integrations/google-calendar` — frontend fetch wrappers around `/api/calendar/*` and `/api/google/status`
- `src/integrations/gmail` — frontend fetch wrappers around `/api/gmail/*` (status, sync, scan, flagged list)
- `src/integrations/nudges` — frontend fetch wrapper around `/api/nudges/check`
- `src/integrations/settings` — frontend fetch wrappers around `/api/settings/{export,wipe}`
- `src/integrations/{supabase,anthropic,openai}` — empty stubs reserved for later steps (the actual Anthropic/OpenAI/Google calls live server-side, never in the browser)
- `server/notion` — Notion SDK client, query layer, rule-based classifier (now a fallback), workspace setup script, `searchTasksAndNotes` for Q&A grounding, `listOverdueTasks` for nudges
- `server/llm` — routing function (`router.ts`, with tests), Anthropic/OpenAI client wrappers (chat + single-turn `*Complete` variants), `routedComplete.ts` (Step 3's routing/fallback reused for structured tasks), chat fallback orchestration, real capture classifier, `emailScan.ts` (action-item classification + draft generation), `nudgeMessage.ts` (overdue-task nudge phrasing), `queryTerms.ts` (derives a Gmail search query from a chat message), `notionContext.ts` / `emailContext.ts` (Q&A grounding)
- `server/google` — OAuth flow (`oauth.ts`, now also `revokeToken`), authenticated client factory (`client.ts`), typed error hierarchy (`errors.ts`), calendar service (`calendar.ts`), Gmail service (`gmail.ts` — the safety-critical file, see [Gmail](#gmail)), sync job (`gmailSync.ts`), and local metadata cache (`gmailStore.ts`, SQLite via `node:sqlite`)
- `server/notify` — `notify(topic, message)`, a reusable ntfy.sh push sender (`ntfy.ts`) plus its env loader; meant to be reused for the daily briefing later
- `server/nudges` — nudge orchestration (`check.ts` — the one entry point, `runNudgeCheck(llmEnv, ntfyEnv, repo)`, written to be callable from a real scheduler later) and the push-throttle store (`nudgeStore.ts`, SQLite via `node:sqlite`)
- `server/settings` — `export.ts` (`buildExport`, assembles the data-export payload) and `wipe.ts` (`wipeEverything`, the disconnect flow)
- `server/apiPlugin.ts` — the Vite dev-server API plugin wiring all of the above into `/api/*`
- `src/sw.ts` — custom service worker (offline shell caching + Web Share Target handling)

## Notion workspace shape

- **Inbox** — every capture lands here first (`Status`: Untriaged/Triaged, `Captured Via`: manual/share-target)
- **Tasks** / **Notes** — classified items, each with a `Project` relation and a `From Inbox` relation back to the originating capture
- **Projects** — Job, Freelance, Personal, Football Coaching, Unsorted (catch-all for low-confidence classifications); Personal has a nested "Genealogy" child page reserved for later
- **Journal** — structure only, not used yet

## Chat routing

`server/llm/router.ts` is a pure, dependency-free function — keyword match on the message text decides Claude vs ChatGPT. If the chosen model's API call fails for any reason, `server/llm/chat.ts` retries the same request on the other model and reports which model actually answered (`ChatMessage.model`) plus a `note` when a fallback happened. If both fail, the Chat screen shows a distinct "assistant unavailable" message rather than a silent failure; if the browser is offline, it shows that instead without attempting the call.

## Google Calendar

Read-only (`calendar.readonly`), one account, OAuth 2.0 with `access_type: offline` + `prompt: consent` so a refresh token is always issued. The refresh token is written straight into `.env` on successful connect (`server/envFile.ts`) — same pattern as the Notion workspace setup in Step 2. `server/google/calendar.ts` is the shared, standalone service module: `listEvents(env, range)` plus `getTodayEvents`/`getTomorrowEvents` convenience wrappers, meant to be reused as-is when later steps cross-reference calendar with email and Notion. A missing or revoked token surfaces as a typed `GoogleNotConnectedError` / `GoogleReconnectRequiredError` rather than a generic failure, so both the Today screen and Chat can show an honest "reconnect your calendar" state instead of crashing or guessing.

## Gmail

**Scopes and the send guarantee.** Alfred requests exactly `gmail.readonly` and `gmail.compose` — never `gmail.send`, never `gmail.modify`. These are added to the same OAuth flow and the same refresh token as Calendar (`server/google/oauth.ts`); reconnecting re-runs consent for the union of scopes. Google's `gmail.compose` grant is technically broad enough to send mail (it's described as "manage drafts and send emails"), so the "Alfred never sends" guarantee here is enforced in code, not by the grant: `server/google/gmail.ts` — the one file that talks to the Gmail API — carries a top-of-file safety-invariant comment, and every write goes through `gmail.users.drafts.create` only. Nothing in `server/` calls `messages.send` or `drafts.send`; this is grep-verified (`grep -rn "\.send(\|drafts\.send\|messages\.send" server/`) and worth re-running after any change to the Gmail code path.

**Sync.** `server/google/gmailSync.ts` backfills the inbox (default 30 days, configurable) in paced batches of 10 (200ms apart) so a large backfill doesn't hammer Gmail's rate limits, storing only metadata — sender, subject, date, snippet, threadId — in a local SQLite cache (`server/google/gmailStore.ts`, `.data/gmail.db`, via Node's built-in `node:sqlite`, no new dependency). Bodies are fetched on-demand, never bulk-stored. A progress indicator on the Today screen polls a status endpoint while sync and scan jobs run.

**Scan.** A separate, user-triggered "Scan" step (`server/llm/emailScan.ts`) runs unscanned emails through the routed model (the same Claude/ChatGPT routing and fallback from Step 3, generalized into `routedComplete.ts` for single-turn structured tasks) to flag whether each needs a reply, has a deadline, and which Notion project it belongs to. Actionable emails are filed into Notion (Inbox, then Tasks or Notes) with a link back to the Gmail thread; emails needing a reply get a real Gmail **draft** — never sent — threaded correctly via `In-Reply-To`/`References`/`threadId`, left for you to review and send yourself.

**Q&A grounding.** Chat's retrieval now spans Notion and email together (`server/llm/notionContext.ts`, `server/llm/emailContext.ts`): a question that looks like it needs email context triggers a live Gmail search plus on-demand body fetch for the top results. The search query is derived from the chat message by stripping stopwords and punctuation (`server/llm/queryTerms.ts`) — Gmail's search ANDs terms by default, so leftover words like "check" or "email" are enough to zero out real results, which is why the stopword list is aggressive.

**Errors.** Three distinct typed errors (`server/google/errors.ts`) drive three distinct UI states: `GoogleNotConnectedError` (never connected — show "Connect Gmail"), `GoogleReconnectRequiredError` (expired/revoked/missing-scope token — show "Reconnect"), and `GoogleApiDisabledError` (the Gmail API itself isn't enabled in the Cloud project — a 403 that reconnecting can never fix, so the UI links straight to Cloud Console instead of offering a reconnect button).

**Privacy.** No email content leaves the app except in the LLM calls needed to classify or draft a reply (Anthropic/OpenAI, same as every other model call in the app).

## Nudges

**Scope.** v1 covers overdue Tasks only: a Notion Task with `Status: Open` and a `Due Date` before today. `NotionRepo.listOverdueTasks()` queries this directly with a compound Notion filter rather than fetching and filtering every task client-side.

**No dismissed state.** There's no "dismiss" action or stored per-task acknowledgement — a nudge is derived live from Notion's current status every time the check runs. Mark the task Done in Notion and its nudge simply stops showing up on the next check, in-app or push.

**Generation.** `server/nudges/check.ts`'s `runNudgeCheck(llmEnv, ntfyEnv, repo)` is the one entry point: it queries overdue tasks, phrases a short, calm reminder for each with the routed model (`server/llm/nudgeMessage.ts`, reusing Step 3's Claude/ChatGPT routing and fallback via `routedComplete.ts`, on Haiku rather than Chat's Opus — same cost reasoning as the email classifier), and pushes each via `notify()`. It's a plain async function with no framework-specific triggering baked in, so a real scheduler can call it exactly this way later; for v1 it's triggered by the Today screen on load.

**Push delivery.** `server/notify/ntfy.ts` exports `notify(topic, message)` — one `POST` to `https://ntfy.sh/<topic>`, no server URL or account needed beyond picking a topic name. It's intentionally generic (not nudge-specific) so the daily briefing can reuse it later. Delivery degrades gracefully: with `NTFY_TOPIC` unset, nudges still show in-app, they just don't push.

**Push throttling.** Since nudges have no dismissed state, the in-app list is always live — but that also means opening Today five times in a day would otherwise fire five phone pushes for the same still-overdue task. `server/nudges/nudgeStore.ts` is a tiny SQLite table (`.data/nudges.db`) recording only "was this task's push already sent today" — it throttles the *push*, not the in-app display, and resets naturally at midnight since it's keyed by date.

## Security (App Lock, export, wipe)

**App Lock.** WebAuthn (`src/lib/webauthn.ts`), verified entirely client-side — no server round-trip, no signature verification against a stored public key. This is a deliberate call, not an oversight: Alfred has no real multi-user backend to protect a remote identity against, so the threat model is someone picking up your already-unlocked device, not a network attacker forging a login. A successful `navigator.credentials.get()` can only happen via the OS's secure hardware actually matching your biometric — that's the property this design leans on. If biometrics aren't available or fail, `src/lib/pin.ts` is the fallback (a salted SHA-256 hash, never the PIN itself, stored via `crypto.subtle`) — the lock can't be turned on without a PIN set first, so there's no way to end up locked out with no way back in. `src/hooks/useLockGate.ts` locks on every cold start and re-locks after the app's been backgrounded for more than 60 seconds (`RELOCK_AFTER_MS` in `src/lib/lock.ts`) — a brief app-switch doesn't force a re-unlock, leaving it backgrounded for real does. WebAuthn requires a secure context; `localhost` counts, but a real deployment needs HTTPS for this to work at all.

**Export.** `GET /api/settings/export` (`server/settings/export.ts`) packages everything Alfred caches locally — Gmail metadata cache, nudge push-throttle history — plus a summary of which integrations are connected and the exact Google scopes requested. It deliberately excludes Notion content (already the source of truth, exportable from Notion directly) and every credential (Notion token, Anthropic/OpenAI keys, Google client secret/refresh token) — those are Alfred's own operating credentials, not "your data." The Settings screen downloads it client-side as a single `alfred-export-<date>.json`.

**Wipe.** `POST /api/settings/wipe` (`server/settings/wipe.ts`) — scoped to exactly what the settings copy promises: revokes the Google OAuth grant with Google directly (`oauth.ts`'s `revokeToken`, not just deleting the local copy), clears the Gmail and nudge SQLite caches, and leaves Notion, the LLM API keys, and the ntfy topic untouched. Requires typing "delete" in the UI, and the server independently re-checks `confirm === "delete"` before doing anything. After a wipe the app looks freshly installed — Today's Schedule/Flagged sections fall back to their "not connected"/"sync your inbox" empty states automatically, since those already keyed off `GoogleNotConnectedError` and an empty cache.

**Scope review.** Re-checked while building this step: `calendar.readonly`, `gmail.readonly`, `gmail.compose` — unchanged since Step 5, and still the narrowest scopes available for what each feature does (no `calendar` write access, no `gmail.modify`, no `gmail.send`). Nothing broader than necessary is requested.

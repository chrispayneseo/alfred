# Alfred

A proactive personal assistant PWA — captures, organizes, and briefs, using Claude/ChatGPT as interchangeable workers and Notion as the single source of truth.

## Status

Step 4 of 8: Google Calendar integration (read-only, one account). The Today screen shows real events for today and tomorrow, with a calm inline "Connect calendar" / "Reconnect calendar" prompt when there's no valid connection. Chat can now answer calendar questions like "how many meetings do I have tomorrow?" — a keyword heuristic detects calendar-related questions, fetches real events, and gives them to the routed model as context, so it answers from real data instead of guessing (and says so honestly if the calendar isn't connected).

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
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` come from a Google Cloud Console OAuth client (Web application type) — the authorized redirect URI must be exactly `http://localhost:5173/api/google/oauth/callback`, and the OAuth consent screen needs the `calendar.readonly` scope with your own account added as a test user
- `GOOGLE_REFRESH_TOKEN` is filled in automatically — open the app, go to Today, and click "Connect calendar"

Run `npm test` to run the standalone router unit tests (`server/llm/router.test.ts`).

## Folder structure

- `src/screens` — the four top-level screens
- `src/components` — shared UI (tab bar, FAB, offline banner, model tag)
- `src/mocks` — stand-in data still used by Today's tasks/notes; everything else uses the `src/integrations/*` API clients
- `src/lib` — routing/storage helpers not tied to a specific vendor
- `src/integrations/notion` — frontend fetch wrappers around the `/api/{capture,tasks,notes,projects}` routes
- `src/integrations/llm` — frontend fetch wrapper around `/api/chat`
- `src/integrations/google-calendar` — frontend fetch wrappers around `/api/calendar/*` and `/api/google/status`
- `src/integrations/{supabase,anthropic,openai,gmail}` — empty stubs reserved for later steps (the actual Anthropic/OpenAI/Google calls live server-side, never in the browser)
- `server/notion` — Notion SDK client, query layer, rule-based classifier (now a fallback), workspace setup script
- `server/llm` — routing function (`router.ts`, with tests), Anthropic/OpenAI client wrappers, chat fallback orchestration, real capture classifier, calendar-context injection for Q&A
- `server/google` — OAuth flow (`oauth.ts`), authenticated client factory (`client.ts`), and the calendar service (`calendar.ts` — the one entry point, `listEvents(env, range)`, that later steps cross-referencing email/Notion should call)
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

Read-only (`calendar.readonly`), one account, OAuth 2.0 with `access_type: offline` + `prompt: consent` so a refresh token is always issued. The refresh token is written straight into `.env` on successful connect (`server/envFile.ts`) — same pattern as the Notion workspace setup in Step 2. `server/google/calendar.ts` is the shared, standalone service module: `listEvents(env, range)` plus `getTodayEvents`/`getTomorrowEvents` convenience wrappers, meant to be reused as-is when Steps 5+ cross-reference calendar with email and Notion. A missing or revoked token surfaces as a typed `GoogleNotConnectedError` / `GoogleReconnectRequiredError` rather than a generic failure, so both the Today screen and Chat can show an honest "reconnect your calendar" state instead of crashing or guessing.

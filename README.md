# Alfred

A proactive personal assistant PWA — captures, organizes, and briefs, using Claude/ChatGPT as interchangeable workers and Notion as the single source of truth.

## Status

Step 3 of 8: real Claude/ChatGPT routing. Chat now makes real model calls — a keyword-based router sends coding/technical questions to Claude (`claude-opus-5`) and everything else to ChatGPT, with automatic same-request fallback to the other model if the first one fails (including hitting a spend cap), and an honest model tag + note when that happens. Capture's classification step (Task vs Note, which Project) is now a real Claude Haiku call instead of a heuristic, falling back to the Step 2 rule-based classifier if the model call fails. Today still runs on Step 1's mock data.

## Stack

React + Vite + TypeScript + Tailwind CSS v4, installable PWA (manifest + service worker + Web Share Target). A small API layer lives inside the Vite dev server (`server/notion/apiPlugin.ts`) so the Notion/Anthropic/OpenAI credentials never ship to the browser and CORS isn't an issue — this gets replaced by Supabase Edge Functions in a later step.

## Develop

```bash
npm install
cp .env.example .env   # fill in NOTION_TOKEN, NOTION_PARENT_PAGE_ID, ANTHROPIC_API_KEY, OPENAI_API_KEY
npm run notion:setup   # one-off: provisions Inbox/Tasks/Notes/Journal/Projects, writes DB IDs into .env
npm run dev
```

`notion:setup` is idempotent to run again by hand, but re-running it creates a second set of databases — it's meant to be run once per workspace. See `.env.example` for the full list of required variables, including the optional `OPENAI_MODEL` override (defaults to `gpt-5.6-terra`).

Run `npm test` to run the standalone router unit tests (`server/llm/router.test.ts`).

## Folder structure

- `src/screens` — the four top-level screens
- `src/components` — shared UI (tab bar, FAB, offline banner, model tag)
- `src/mocks` — stand-in data still used by Today; Capture/Browse/Chat use the `src/integrations/*` API clients instead
- `src/lib` — routing/storage helpers not tied to a specific vendor
- `src/integrations/notion` — frontend fetch wrappers around the `/api/{capture,tasks,notes,projects}` routes
- `src/integrations/llm` — frontend fetch wrapper around `/api/chat`
- `src/integrations/{supabase,anthropic,openai,google-calendar,gmail}` — empty stubs reserved for later steps (the actual Anthropic/OpenAI calls live server-side in `server/llm`, never in the browser)
- `server/notion` — Notion SDK client, query layer, rule-based classifier (now a fallback), workspace setup script
- `server/llm` — routing function (`router.ts`, with tests), Anthropic/OpenAI client wrappers, chat fallback orchestration, real capture classifier
- `server/notion/apiPlugin.ts` — the Vite dev-server API plugin wiring both of the above into `/api/*`
- `src/sw.ts` — custom service worker (offline shell caching + Web Share Target handling)

## Notion workspace shape

- **Inbox** — every capture lands here first (`Status`: Untriaged/Triaged, `Captured Via`: manual/share-target)
- **Tasks** / **Notes** — classified items, each with a `Project` relation and a `From Inbox` relation back to the originating capture
- **Projects** — Job, Freelance, Personal, Football Coaching, Unsorted (catch-all for low-confidence classifications); Personal has a nested "Genealogy" child page reserved for later
- **Journal** — structure only, not used yet

## Chat routing

`server/llm/router.ts` is a pure, dependency-free function — keyword match on the message text decides Claude vs ChatGPT. If the chosen model's API call fails for any reason, `server/llm/chat.ts` retries the same request on the other model and reports which model actually answered (`ChatMessage.model`) plus a `note` when a fallback happened. If both fail, the Chat screen shows a distinct "assistant unavailable" message rather than a silent failure; if the browser is offline, it shows that instead without attempting the call.

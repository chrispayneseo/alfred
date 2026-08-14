# Alfred

A proactive personal assistant PWA — captures, organizes, and briefs, using Claude/ChatGPT as interchangeable workers and Notion as the source of truth.

## Status

Step 2 of 8: real Notion integration. Capture and Browse now read/write a real Notion workspace (Inbox → Tasks/Notes, with a Project relation and a rule-based type/project classifier). Today and Chat still run on Step 1's mock data — untouched this step. No Claude/OpenAI calls yet — the classifier is a placeholder heuristic, replaced with real model routing in Step 3.

## Stack

React + Vite + TypeScript + Tailwind CSS v4, installable PWA (manifest + service worker + Web Share Target). A small API layer lives inside the Vite dev server (`server/notion/apiPlugin.ts`) so the Notion token never ships to the browser and CORS isn't an issue — this gets replaced by Supabase Edge Functions in a later step.

## Develop

```bash
npm install
cp .env.example .env   # fill in NOTION_TOKEN and NOTION_PARENT_PAGE_ID
npm run notion:setup   # one-off: provisions Inbox/Tasks/Notes/Journal/Projects, writes DB IDs into .env
npm run dev
```

`notion:setup` is idempotent to run again by hand, but re-running it creates a second set of databases — it's meant to be run once per workspace. See `.env.example` for the full list of required variables.

## Folder structure

- `src/screens` — the four top-level screens
- `src/components` — shared UI (tab bar, FAB, offline banner, model tag)
- `src/mocks` — stand-in data still used by Today/Chat; Capture/Browse now use `src/integrations/notion` instead
- `src/lib` — routing/storage helpers not tied to a specific vendor
- `src/integrations/notion` — frontend fetch wrappers around the `/api/*` routes
- `src/integrations/{supabase,anthropic,openai,google-calendar,gmail}` — empty stubs reserved for later steps
- `server/notion` — Notion SDK client, query layer, rule-based classifier, workspace setup script, and the Vite dev-server API plugin
- `src/sw.ts` — custom service worker (offline shell caching + Web Share Target handling)

## Notion workspace shape

- **Inbox** — every capture lands here first (`Status`: Untriaged/Triaged, `Captured Via`: manual/share-target)
- **Tasks** / **Notes** — classified items, each with a `Project` relation and a `From Inbox` relation back to the originating capture
- **Projects** — Job, Freelance, Personal, Football Coaching, Unsorted (catch-all for low-confidence classifications); Personal has a nested "Genealogy" child page reserved for later
- **Journal** — structure only, not used yet

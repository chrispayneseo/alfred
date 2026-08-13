# Alfred

A proactive personal assistant PWA — captures, organizes, and briefs, using Claude/ChatGPT as interchangeable workers and Notion as the source of truth.

## Status

Step 1 of 8: scaffold. All four screens (Today, Chat, Capture, Browse) run against mocked data — no live API calls yet.

## Stack

React + Vite + TypeScript + Tailwind CSS v4, installable PWA (manifest + service worker + Web Share Target).

## Develop

```bash
npm install
npm run dev
```

## Folder structure

- `src/screens` — the four top-level screens
- `src/components` — shared UI (tab bar, FAB, offline banner, model tag)
- `src/mocks` — stand-in data for tasks/events/notes/projects/chat, swapped for real APIs later
- `src/lib` — routing/storage helpers not tied to a specific vendor
- `src/integrations/{supabase,notion,anthropic,openai,google-calendar,gmail}` — empty stubs reserved for later steps
- `src/sw.ts` — custom service worker (offline shell caching + Web Share Target handling)

# Changelog

Project history that used to live in the README's Status section.

## Deployment pass (Step 9)

All 8 planned steps are complete (multi-account Google, above, was the last of them) — this pass is the deployment that follows: Alfred now runs on Vercel with a real Postgres database (Neon), not just `npm run dev` on one machine. The backend was a Vite dev-server plugin that only ran under `vite dev`; it's now split into a shared, transport-agnostic handler (`server/handleApiRequest.ts`) driven by two thin adapters — the same dev plugin locally, a Vercel serverless function in production — and everything that used to live in local SQLite or a hand-written `.env` file (OAuth tokens, the Gmail cache, nudge history, background-job status) now lives in Postgres, since none of that survives a stateless, ephemeral serverless filesystem. See [Deployment](#deployment) below for the full architecture.

**Alfred never sends email.** Only `gmail.readonly` and `gmail.compose` are requested — never `gmail.send` — and the code only ever calls `gmail.users.drafts.create`; nothing in `server/` calls `messages.send` or `drafts.send`. See [Gmail](#gmail) below for the full safety model.

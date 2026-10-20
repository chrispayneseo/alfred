# Alfred

A private-by-design, proactive personal assistant PWA. Alfred captures, organizes and briefs, using Claude and ChatGPT as interchangeable workers and Notion as the single source of truth.

> Source is public for reference and portfolio purposes only; see [LICENSE](LICENSE). It is not open-source software.

**Alfred never sends email.** It requests only `gmail.readonly` and `gmail.compose` (never `gmail.send`) and only ever creates drafts. See [docs/gmail.md](docs/gmail.md) for the full safety model.

## Stack

- **Frontend:** React, Vite, TypeScript and Tailwind CSS v4, shipped as an installable PWA (manifest, service worker, Web Share Target).
- **Backend:** one shared, transport-agnostic handler (`server/handleApiRequest.ts`) driven by a Vite dev plugin locally and a Vercel serverless function in production, so Notion, Anthropic, OpenAI and Google credentials never reach the browser.
- **Data:** Postgres (Neon) for OAuth tokens, the Gmail metadata cache, nudge history and job status; Notion for tasks, notes and projects.
- **Optional local services:** `dell-node/` (Python) and `whatsapp-ingress/` add a private, on-device agent layer.

## Quick start

```bash
npm install
cp .env.example .env   # fill in the credentials listed below
npm run notion:setup   # one-off: provisions Inbox/Tasks/Notes/Journal/Projects, writes DB IDs into .env
npm run dev
```

See `.env.example` for the full list of required variables. Notes on the trickier ones:
- `DATABASE_URL` — a Postgres connection string. The dev instructions above assume you've already run through [Deployment](docs/deployment.md) once (`vercel link` + `vercel install neon`), which writes this into `.env.local` automatically; Vite's `loadEnv()` picks up `.env.local` alongside `.env` with no extra config. Local dev and production share this one database by design (see Deployment) — a local test of Settings' wipe/disconnect really does revoke your production Google grant and clear your production Gmail cache.
- `OPENAI_MODEL` is optional, defaults to `gpt-5.6-terra`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` come from a Google Cloud Console OAuth client (Web application type). In the Cloud Console you need both the **Calendar API** and the **Gmail API** enabled for the project (Library → search each → Enable), and the OAuth consent screen needs the `calendar.events`, `gmail.readonly`, `gmail.compose`, and `userinfo.email` scopes, with every Google account you plan to connect added as a test user (the project stays in "Testing" mode, so each account needs to be added explicitly — see [Multiple Google accounts](docs/architecture.md#multiple-google-accounts)). `calendar.events` was `calendar.readonly` before Chat gained the ability to create events — accounts connected under the old scope need reconnecting once (Settings → Google accounts) before event creation works; everything else keeps working unaffected in the meantime.
- `GOOGLE_REDIRECT_URI` — leave unset locally (defaults to `http://localhost:5173/api/google/oauth/callback`); set explicitly in Vercel for Production only (see Deployment). Whichever URI is active must also be in the OAuth client's Authorized redirect URIs list in Cloud Console.
- Connected Google accounts live in Postgres now, not `.env` — open the app, go to Today (or Settings → Google accounts), and click "Connect calendar" / "Connect a Google account". Repeat for a second account via Settings → "Connect another Google account".
- `NTFY_TOPIC` — pick your own unguessable topic name (ntfy.sh topics aren't private unless you add auth) and subscribe to `https://ntfy.sh/<topic>` in the ntfy app or web UI to actually receive the pushes; leave blank to skip push delivery and still see nudges in-app only

Run `npm test` to run the standalone router unit tests (`server/llm/router.test.ts`).

## Documentation

| Topic | Where |
| --- | --- |
| Folder structure, Notion workspace, chat routing, calendar, multi-account, nudges | [docs/architecture.md](docs/architecture.md) |
| Gmail scopes, sync, scan and the never-sends guarantee | [docs/gmail.md](docs/gmail.md) |
| App Lock, data export and wipe | [docs/security.md](docs/security.md) |
| Vercel and Neon deployment | [docs/deployment.md](docs/deployment.md) |
| Dell node (local agent layer) | [dell-node/README.md](dell-node/README.md) |
| Project history | [CHANGELOG.md](CHANGELOG.md) |

Report security issues privately; see [SECURITY.md](SECURITY.md).

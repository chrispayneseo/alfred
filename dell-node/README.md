# Alfred Dell Core

This directory tracks the Dell's existing FastAPI/Ollama Compose stack. The
WhatsApp inbox addition mounts the collector's local SQLite directory into
Core with group-only access; it does not expose Ollama or the database on LAN.

The collector stores incoming text first. Core then uses Qwen3 1.7B locally to
suggest `note`, `task`, `reminder`, or `clarify`. The Capture → Inbox screen
requires explicit approval before filing. No WhatsApp text is sent to a cloud
model. Approved notes enter Core memory; approved tasks and dated reminders
enter `inbox_filed` in Core SQLite and appear on Alfred's Today screen. The
Capture screen can also create local items directly, without WhatsApp.
Completed tasks and reminders stay in SQLite and can be reopened.

Chat now supports local recall of saved notes, tasks, and reminders. SQLite
FTS5 indexes are created and backfilled on the first upgraded Core start;
subsequent edits and deletions update them automatically. Recall responses
include links to their saved sources. Questions with no matching saved item
say so instead of inventing one. The saved text is treated as untrusted data
when shown to the local model. Settings lets Chris correct or forget memories;
Today lets him correct or forget tasks and reminders. These actions update
search immediately. A forgotten WhatsApp filing cannot be silently recreated
by re-filing the same original message. Recall and source details stay on the
Dell; cloud escalation still requires the existing approval flow and sends
only the user's typed prompt, not saved items.

Phone alerts are optional and disabled by default. Copy
`.env.notifications.example` to `.env.notifications`, set `ALFRED_NTFY_TOPIC`
to an unguessable 32+ character topic, and subscribe to it in the ntfy phone app.
ntfy.sh has a free tier, but topics are public, so Alfred deliberately sends
only a generic “reminder due” message, never the reminder title or details.
`ALFRED_REMINDER_HOUR` defaults to 9 (Europe/London). The Dell checks each
minute and retries failed sends after 15 minutes; a successful send is recorded
once in SQLite. The ntfy topic is not returned by the API. Without a topic,
reminders remain visible in Today but do not produce phone alerts. No external
actions beyond the optional generic push are performed.

`compose.yml` is intended for `/opt/alfred-node` on the current Dell, where
Chris's group ID is 1000. The shared collector directory must be group-owned
by that group, mode `2770`; its SQLite database and WAL files must be group
writable. Keep `.env`, collector tokens, databases, and model data out of Git.

To run the inbox tests locally, install `core/requirements.txt` into a virtual
environment and run `python -m unittest discover -p 'test_*.py' -v` from
`core/`.

# Alfred Dell Core

This directory tracks the Dell's existing FastAPI/Ollama Compose stack. The
WhatsApp inbox addition mounts the collector's local SQLite directory into
Core with group-only access; it does not expose Ollama or the database on LAN.

The collector stores incoming text first. Core then uses Qwen3 1.7B locally to
suggest `note`, `task`, `reminder`, or `clarify`. The Capture → Inbox screen
requires explicit approval before filing. No WhatsApp text is sent to a cloud
model. Approved notes enter Core memory; approved tasks and dated reminder
drafts enter `inbox_filed` in Core SQLite. Reminder notifications and external
actions are **not implemented yet**.

`compose.yml` is intended for `/opt/alfred-node` on the current Dell, where
Chris's group ID is 1000. The shared collector directory must be group-owned
by that group, mode `2770`; its SQLite database and WAL files must be group
writable. Keep `.env`, collector tokens, databases, and model data out of Git.

To run the inbox tests locally, install `core/requirements.txt` into a virtual
environment and run `python -m unittest -v test_inbox` from `core/`.

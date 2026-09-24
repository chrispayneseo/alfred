# Alfred Core bootstrap

Alfred Core owns identity, context, memory, permissions, planning, execution
state, and audit. Models and integrations are workers that the Core may invoke;
they never own those decisions.

## Scope

This first release has an authenticated inbound API, request normalization, a
conservative policy decision, a durable agent session, and JSONL audit events.
It intentionally has no live external service and no write-capable tool.

## Local run

Set these environment variables locally (never commit the token):

```bash
ALFRED_CORE_API_TOKEN=replace-with-a-long-random-token
ALFRED_AUDIT_PATH=./data/audit.jsonl
```

Start the service with:

```bash
npm run dev -- --no-ui
```

Send `POST /alfred/v1/requests` with `Authorization: Bearer <token>` and:

```json
{
  "user": "Chris",
  "channel": "web",
  "message": "What can you do today?",
  "conversationId": "first-test"
}
```

The service returns a session ID and the policy result. Audit events append to
`data/audit.jsonl`.

## Durable storage

`db/migrations/001_core.sql` creates the Core-owned tables for requests,
memories, plans, approvals and audit events. Apply it to the Dell's private
Postgres database before setting `ALFRED_DATABASE_URL`. When configured, audit
events are stored in Postgres; JSONL remains only a local bootstrap fallback.

`search_alfred_memory` is read-only and safely returns no results until the
database and owner UUID are configured.

`save_alfred_memory` is Alfred's first durable write. Eve pauses for an
explicit approval before its Core-owned database insert; every entry records
kind, scope, source, confidence and optional source reference.

## Dell deployment preparation

`deploy/docker-compose.yml` runs Postgres bound to loopback only, so it is not
reachable from the network. On the Dell, copy `deploy/.env.dell.example` to
`deploy/.env`, set a unique database password, start the database, then set
`ALFRED_DATABASE_URL` and run `npm run db:migrate` from the project root.

The systemd unit is a production starting point. It assumes a dedicated
`alfred` Linux account, an application checkout at `/opt/alfred-core`, and
runtime configuration in `/etc/alfred-core/alfred-core.env`.

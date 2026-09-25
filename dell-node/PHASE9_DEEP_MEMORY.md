# Phase 9 — Deep Memory & Personal Knowledge

Phase 9 turns Alfred's already-approved local memory into a more useful personal knowledge surface without creating a second memory authority.

It adds deterministic local views for:

- provenance and confidence
- memory age / stale-review bands
- named entities and relationships
- decision, preference and constraint history
- supersession / change history
- unresolved contradictions
- cross-source local recall spanning durable memories, tasks and reminders

## Safety model

Phase 9 never auto-promotes model output. It does not copy Gmail or Calendar payloads into a durable shadow index, and TTL conversation turns do not become durable knowledge. Conflicts remain owner-review items through the existing memory-candidate system.

There is no new executor, planner, provider or cloud dependency.

## Endpoints

- `GET /v1/core/knowledge/status`
- `GET /v1/core/knowledge/search?q=...`
- `GET /v1/core/knowledge/entities`
- `GET /v1/core/knowledge/entities/{entity}`
- `GET /v1/core/knowledge/history`
- `GET /v1/core/knowledge/contradictions`
- `GET /v1/core/phase9/status`

## Sequential deployment

Phase 8 must be live-accepted first. Checkout the exact Phase 9 release and run:

```bash
sudo bash dell-node/scripts/deploy-phase9.sh
```

The installer reruns Phase 8 live acceptance before changing Core and writes `.phase9-live-accepted` only after Phase 9 live acceptance passes.

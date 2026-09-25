# Phase 10 — Proactive Intelligence

Phase 10 adds a local, deterministic signal engine for the things Alfred should notice without turning Alfred into a noisy briefing bot.

Signals include overdue/due-today local commitments, waiting exact-scope approvals, execution problems, captured items needing review, unresolved knowledge contradictions and stale-memory review candidates.

Interventions are bounded in-app/event-driven items. Phase 10 does not enable an automatic daily briefing, unsolicited cloud reasoning, automatic external actions or a second executor.

Endpoints:

- `GET /v1/core/intelligence/status`
- `GET /v1/core/intelligence/signals`
- `GET /v1/core/phase10/status`

Sequential deployment requires Phase 9 live acceptance first:

```bash
sudo bash dell-node/scripts/deploy-phase10.sh
```

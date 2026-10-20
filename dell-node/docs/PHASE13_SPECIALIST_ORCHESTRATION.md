# Phase 13 — Specialist Model & Tool Orchestration

Phase 13 centralises deterministic specialist planning while preserving Alfred Core as the authority over privacy, providers and execution.

The broker classifies a request into web research, coding, long reasoning, connected-account work, local-preferred work or general reasoning. It selects a primary configured specialist, publishes at most one fallback, and applies explicit prompt/context budgets.

The planning surface itself never invokes a provider. Existing `cloud_execution` remains the only off-device model-call boundary and still owns privacy approval, provider configuration checks, audit and completed-response handling.

## Limits

- cloud prompt budget: 12,000 characters
- connected-context budget: 6,000 characters
- maximum planned fallbacks: 1
- fallback is never automatic
- durable memory is never automatically attached
- connected-account data is never automatically attached
- runtime provider definition is not supported

## Endpoints

- `GET /v1/core/specialists/status`
- `GET /v1/core/specialists/plan?q=...`
- `GET /v1/core/phase13/status`

## Sequential deployment

Phase 12 must be live-accepted first:

```bash
sudo bash dell-node/scripts/deploy-phase13.sh
```

The installer writes `.phase13-live-accepted` only after the Phase 13 live smoke succeeds.

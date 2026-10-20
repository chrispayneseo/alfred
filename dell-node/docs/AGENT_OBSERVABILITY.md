# Phase 5H — Agent Observability

Phase 5H adds a read-only operator view over the durable agent state created by Phases 5A–5G.

It does **not** add another planner, executor, approval system, retry system or model call. The existing Core remains authoritative.

## Today / Agent Activity

Authenticated Core routes:

- `GET /v1/core/observability/status`
- `GET /v1/core/observability/today`

The web Today screen reads the second route and shows:

- active durable goals;
- current step and deterministic explanation of why it is next or blocked;
- waiting exact-scope approvals;
- verified completed work from Phase 5E receipts;
- failures/reconciliation items that need attention;
- reusable workflow recipe runs created today.

The view is refreshed every 30 seconds and can be refreshed manually. Refresh is read-only.

## Content boundary

Phase 5H is intentionally metadata-only. It never exposes or copies:

- goal text;
- step arguments;
- tool results;
- verification payloads;
- Calendar event content;
- Gmail content;
- browser page text;
- local file content;
- recipe parameter values or parameter hashes;
- approval scope hashes;
- credentials, tokens or cookies.

It may expose only operational metadata such as IDs, action names, states, counts, integration owner, deterministic risk/effect labels, timestamps and generic explanations.

## Why explanations

Explanations are deterministic application code derived from existing state. Examples:

- a ready recipe step explains that it was selected by the named static recipe;
- a pending step explains that verified prerequisites are still outstanding;
- a running step explains that it is executing through the policy-gated verified executor;
- an approval-gated step explains that exact-scope owner approval is required;
- an ambiguous mutation explains that Phase 5E reconciliation is required before retry.

No language model generates or ranks these explanations.

## Safety properties

- read-only;
- no tool execution;
- no approval resolution;
- no plan creation or replanning;
- no automatic agent start;
- no external mutation;
- no cloud model;
- no second durable execution log;
- no changes to the Phase 5A–5G policy path.

## Acceptance

Run:

```bash
sudo bash /opt/alfred-node/scripts/phase5-agent-observability-smoke.sh
```

The smoke checks the metadata-only contract and confirms that reading the Today view does not create a Phase 5E operation or execution receipt.

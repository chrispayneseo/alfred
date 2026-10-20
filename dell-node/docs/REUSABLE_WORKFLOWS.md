# Phase 5G — Reusable Workflows

Phase 5G adds named, versioned recipes that compile into Alfred's existing durable
agent architecture. A recipe is not a new executor and cannot grant itself any
permission.

## Execution path

```text
owner request
  -> Phase 5G static recipe compiler
  -> Phase 5C verified workflow
  -> Phase 5A durable goal/plan
  -> Phase 5B bounded agent loop
  -> existing Core policy + Phase 5D exact-scope approval
  -> Phase 5E verification/recovery
  -> Phase 5F browser boundary when a browser tool is used
```

Recipes never auto-start. `POST /v1/core/recipes/{recipe_id}/run` counts as the
explicit owner start and delegates to the same bounded agent loop used by normal
goals.

## Built-in recipes

| Recipe | Purpose | Current actions |
| --- | --- | --- |
| `prepare_tomorrow` | Review one local calendar day and open Alfred tasks | Calendar read, Tasks read |
| `deal_with_forwarded_message` | Prepare a follow-up task containing a forwarded message | Task create, approval required |
| `research_purchase` | Inspect a supplied public product/research page | Browser open, inspect, close |
| `plan_dinner_out` | Inspect a supplied public restaurant/booking page | Browser open, inspect, close |
| `prepare_client_task` | Prepare one local client task | Task create, approval required |

The browser recipes deliberately do not contain `browser.submit`. They remain
usable while `ALFRED_BROWSER_SUBMIT_ENABLED=false`.

## Safety properties

- recipe definitions live in application code and are versioned;
- inputs are bounded and type-checked before a workflow is created;
- unknown parameters are rejected;
- recipes can emit only actions already registered in Alfred Core;
- required capabilities are checked before durable recipe state is created;
- recipe compilation does not execute tools or call a model;
- recipe instances store a parameter hash/count as metadata rather than a second
  copy of parameter values;
- actual workflow arguments remain in the existing durable goal/workflow store;
- mutations retain the existing exact-scope approval boundary;
- verified scalar workflow bindings remain the only automatic inter-step data
  hand-off mechanism;
- Phase 5E remains authoritative for retries, idempotency and reconciliation;
- browser content remains untrusted and Phase 5F policy remains authoritative;
- no recipe introduces `email.send`, browser downloads/uploads, credential entry,
  payment-card entry or automatic browser submission.

## API

- `GET /v1/core/recipes/status` — metadata-only Phase 5G state
- `GET /v1/core/recipes` — recipe catalog and current capability availability
- `POST /v1/core/recipes/{recipe_id}/instantiate` — create a durable workflow but do not start it
- `POST /v1/core/recipes/{recipe_id}/run` — instantiate and explicitly start through Phase 5B
- `GET /v1/core/recipes/instances/{instance_id}` — retrieve one authenticated recipe instance

## Extending the catalog

New recipes should be added as deterministic compiler branches with bounded
parameter definitions and regression tests. Do not add a generic template
language, dynamic code evaluation, runtime tool invention or a second execution
path. Any future recipe that includes a consequential external action must rely
on the existing Core approval policy rather than weakening it inside the recipe.

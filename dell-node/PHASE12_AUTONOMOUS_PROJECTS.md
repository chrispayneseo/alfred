# Phase 12 — Autonomous Projects

Phase 12 adds durable multi-milestone projects without adding a second execution engine.

A project contains up to eight ordered milestones. Each milestone references a registered Phase 11 operation and is validated through the non-mutating operation preview boundary before the project is stored.

When a project is run, Alfred may create at most one new milestone goal in that invocation. That milestone then runs through the existing reusable-workflow compiler, durable goals, bounded agent loop, exact-scope approvals, verification, retries and reconciliation. If it becomes active, awaits approval, blocks or fails, the project stops rather than pushing into the next milestone.

Project cancellation cancels unstarted project milestones only. It does not silently cancel an already-created durable goal.

## Endpoints

- `GET /v1/core/projects/status`
- `GET /v1/core/projects`
- `POST /v1/core/projects`
- `GET /v1/core/projects/{project_id}`
- `POST /v1/core/projects/{project_id}/run`
- `POST /v1/core/projects/{project_id}/cancel`
- `GET /v1/core/phase12/status`

## Boundaries

- maximum 8 milestones per project
- maximum 1 new durable milestone goal per project run call
- no project-level auto approval
- no ambiguous mutation replay
- no dynamic tools or operations
- no second executor
- no cloud model required for project coordination

## Sequential deployment

Phase 11 must be live-accepted first. Checkout the exact Phase 12 release and run:

```bash
sudo bash dell-node/scripts/deploy-phase12.sh
```

The installer reruns Phase 11 live acceptance before changing Core and writes `.phase12-live-accepted` only after Phase 12 live acceptance succeeds.

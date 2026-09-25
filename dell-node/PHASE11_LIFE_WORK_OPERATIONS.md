# Phase 11 — Life & Work Operations

Phase 11 gives Alfred a curated operations layer for recurring personal and work jobs while preserving the existing Core execution model.

Current first-party operations cover tomorrow preparation, forwarded-message follow-up, purchase research, dinner-out planning, client tasks and home/admin tasks.

Operations are static application-code aliases over Phase 5G reusable recipes. Preview validates and compiles without creating a goal. Run delegates to the existing recipe runner, durable goals, bounded agent loop and exact-scope approvals.

Phase 11 cannot define tools at runtime, send email, or automatically submit purchases/bookings.

Endpoints:

- `GET /v1/core/operations/status`
- `GET /v1/core/operations/catalog`
- `POST /v1/core/operations/{operation_id}/preview`
- `POST /v1/core/operations/{operation_id}/run`
- `GET /v1/core/phase11/status`

Sequential install after Phase 10 live acceptance:

```bash
sudo bash dell-node/scripts/deploy-phase11.sh
```

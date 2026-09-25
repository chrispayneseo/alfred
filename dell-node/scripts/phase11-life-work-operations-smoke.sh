#!/usr/bin/env bash
set -euo pipefail
cd /opt/alfred-node

echo "=== PHASE 11 LIFE & WORK OPERATIONS CONTRACT ==="
sudo docker compose exec -T core python - <<'PY'
from app import operations, phase11_acceptance, proactive
from app.db import connection


def counts():
    with connection() as db:
        return {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("core_executions", "approvals", "agent_goals", "agent_recipe_instances")}

before = counts()
status = phase11_acceptance.acceptance_status()
catalog = operations.catalog()
preview = operations.preview("prepare_client_task", {"title": "Smoke test task", "detail": "", "due": None})
after = counts()
paths = {route.path for route in proactive.router.routes}
assert status["mode"] == "phase11_life_work_operations_acceptance_v1"
assert status["accepted"] is True, status["failed_checks"]
assert status["check_count"] == 10
assert status["new_executor"] is False
assert status["runtime_tool_definition"] is False
assert status["automatic_purchase_or_booking"] is False
assert len(catalog) >= 5
assert preview["will_start"] is False and preview["will_mutate"] is False
assert before == after, (before, after)
for path in (
    "/v1/core/operations/status", "/v1/core/operations/catalog",
    "/v1/core/operations/{operation_id}/preview", "/v1/core/operations/{operation_id}/run",
    "/v1/core/phase11/status",
):
    assert path in paths, path
print("PASS: Phase 11 operations are static aliases over registered recipes")
print("PASS: operation preview cannot start work or mutate state")
print("PASS: operation runs reuse the bounded agent loop and exact-scope approvals")
print("PASS: no purchase/booking submit or email-send operation was introduced")
print("PASS: Phase 11 adds no executor")
print(f"  operations: {len(catalog)}")
PY

echo
echo "=== PHASE 11 ADVERSARIAL ACCEPTANCE ==="
sudo docker compose run --rm --no-deps \
  -v /opt/alfred-node/core/test_phase11_operations.py:/app/test_phase11_operations.py:ro \
  core python -m unittest test_phase11_operations -v

echo
echo "Phase 11 acceptance completed without running an operation."

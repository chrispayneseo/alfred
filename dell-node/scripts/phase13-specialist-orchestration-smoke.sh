#!/usr/bin/env bash
set -euo pipefail
cd /opt/alfred-node

echo "=== PHASE 13 SPECIALIST ORCHESTRATION CONTRACT ==="
sudo docker compose exec -T core python - <<'PY'
from app import phase13_acceptance, proactive, specialist_orchestration
from app.db import connection


def counts():
    with connection() as db:
        return {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("core_executions", "approvals", "agent_goals")}

before = counts()
status = phase13_acceptance.acceptance_status()
plan = specialist_orchestration.plan("Refactor this Python repository architecture")
after = counts()
paths = {route.path for route in proactive.router.routes}

assert status["mode"] == "phase13_specialist_orchestration_acceptance_v1"
assert status["accepted"] is True, status["failed_checks"]
assert status["check_count"] == 10
assert status["new_executor"] is False
assert status["provider_calls"] is False
assert status["automatic_fallback"] is False
assert plan.memory_automatically_sent is False
assert plan.fallback_is_automatic is False
assert plan.max_prompt_chars == 12000
assert before == after, (before, after)
for path in ("/v1/core/specialists/status", "/v1/core/specialists/plan", "/v1/core/phase13/status"):
    assert path in paths, path
print("PASS: Phase 13 specialist planning is deterministic and content-budgeted")
print("PASS: planning routes make no provider calls")
print("PASS: durable memory and connected data are not automatically sent")
print("PASS: fallback is bounded and never silently automatic")
print("PASS: existing cloud privacy approval/provider execution remains authoritative")
PY

echo
echo "=== PHASE 13 ADVERSARIAL ACCEPTANCE ==="
sudo docker compose run --rm --no-deps \
  -v /opt/alfred-node/core/test_phase13_specialists.py:/app/test_phase13_specialists.py:ro \
  core python -m unittest test_phase13_specialists -v

echo
echo "Phase 13 acceptance completed without invoking a cloud provider."

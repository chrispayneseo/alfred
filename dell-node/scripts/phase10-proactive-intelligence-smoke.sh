#!/usr/bin/env bash
set -euo pipefail
cd /opt/alfred-node

echo "=== PHASE 10 PROACTIVE INTELLIGENCE CONTRACT ==="
sudo docker compose exec -T core python - <<'PY'
from app import phase10_acceptance, proactive_intelligence, proactive
from app.db import connection


def counts():
    with connection() as db:
        return {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("core_executions", "approvals", "agent_goals")}

before = counts()
status = phase10_acceptance.acceptance_status()
signals = proactive_intelligence.signals()
after = counts()
paths = {route.path for route in proactive.router.routes}
assert status["mode"] == "phase10_proactive_intelligence_acceptance_v1"
assert status["accepted"] is True, status["failed_checks"]
assert status["check_count"] == 10
assert signals["daily_briefing"] is False
assert signals["unsolicited_cloud_reasoning"] is False
assert signals["automatic_external_action"] is False
assert status["new_executor"] is False
assert before == after, (before, after)
for path in ("/v1/core/intelligence/status", "/v1/core/intelligence/signals", "/v1/core/phase10/status"):
    assert path in paths, path
print("PASS: Phase 10 detects bounded local attention signals")
print("PASS: exact-scope approvals remain pauses, never bypasses")
print("PASS: interventions are in-app/event-driven, not an automatic daily briefing")
print("PASS: proactive detection performs no external action and uses no cloud model")
print("PASS: Phase 10 adds no executor")
print(f"  signals now: {signals['count']}")
print(f"  interrupt-worthy: {signals['interruptions']}")
PY

echo
echo "=== PHASE 10 ADVERSARIAL ACCEPTANCE ==="
sudo docker compose run --rm --no-deps \
  -v /opt/alfred-node/core/test_phase10_intelligence.py:/app/test_phase10_intelligence.py:ro \
  core python -m unittest test_phase10_intelligence -v

echo
echo "Phase 10 acceptance completed without unsolicited delivery or external mutation."

#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

echo "=== PHASE 6 DAILY UTILITY CONTRACT ==="

sudo docker compose exec -T core python - <<'PY'
from app import daily_operations, phase6_acceptance, proactive
from app.db import connection


def counts():
    with connection() as db:
        values = {}
        for table in (
            "core_executions",
            "core_execution_receipts",
            "core_reliability_operations",
            "approvals",
            "agent_goals",
            "agent_goal_runs",
            "agent_recipe_instances",
        ):
            values[table] = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        return values


before = counts()
status = phase6_acceptance.acceptance_status()
daily = daily_operations.today_view()
after = counts()
paths = {route.path for route in proactive.router.routes}

assert status.get("mode") == "phase6_daily_utility_acceptance_v1"
assert status.get("accepted") is True, status.get("failed_checks")
assert status.get("failed_checks") == []
assert status.get("check_count") == 10
assert status.get("executor_hooks_added") is False
assert status.get("policy_changes") is False
assert status.get("mutations") is False
assert status.get("cloud_models") is False
assert daily.get("mode") == "daily_command_centre_v1"
assert daily.get("capture_mode") == "reviewed_capture_v1"
assert daily.get("dispatch_mode") == "phase5_guarded_dispatch_v1"
assert daily.get("raw_forwarded_body_exposed") is False
assert daily.get("forwarded_detail_exposed") is False
assert daily.get("cloud_models") is False
assert before == after, (before, after)

for path in (
    "/v1/core/daily/status",
    "/v1/core/daily/today",
    "/v1/core/daily/intake/{message_id}/review",
    "/v1/core/daily/intake/{message_id}/propose",
    "/v1/core/daily/intake/{message_id}/resolve",
    "/v1/core/phase6/status",
):
    assert path in paths, path

print("PASS: Phase 6A reviewed capture is active without treating forwards as instructions")
print("PASS: Phase 6B owner review locks the fields used for Core proposal scope")
print("PASS: Phase 6C dispatch delegates to Phase 5 exact-scope approval/resume")
print("PASS: Phase 6D command centre combines intake, local items and agent metadata")
print("PASS: Phase 6E acceptance preserves Phase 5 browser/email/executor boundaries")
print("PASS: Reading daily/acceptance surfaces creates no execution or approval state")
print()
print("Phase 6 state:")
print(f"  mode: {status.get('mode')}")
print(f"  accepted: {str(bool(status.get('accepted'))).lower()}")
print(f"  checks: {status.get('check_count')}")
print(f"  pending intake: {daily.get('counts', {}).get('pending_intake')}")
print(f"  needs you: {daily.get('counts', {}).get('needs_you')}")
print(f"  active goals: {daily.get('counts', {}).get('active_goals')}")
print(f"  completed today: {daily.get('counts', {}).get('completed_work_today')}")
PY

echo
echo "=== PHASE 6 ADVERSARIAL ACCEPTANCE ==="
sudo docker compose run --rm --no-deps \
  -v /opt/alfred-node/core/test_phase6_daily_utility.py:/app/test_phase6_daily_utility.py:ro \
  -v /opt/alfred-node/core/test_phase6_acceptance.py:/app/test_phase6_acceptance.py:ro \
  core python -m unittest test_phase6_daily_utility test_phase6_acceptance -v

echo
echo "Phase 6 acceptance completed using temporary test stores."
echo "No raw forward was executed, no live approval was resolved and no external mutation was performed by this smoke."

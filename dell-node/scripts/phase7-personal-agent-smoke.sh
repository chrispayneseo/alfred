#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

echo "=== PHASE 7 PERSONAL AGENT EXPERIENCE CONTRACT ==="

sudo docker compose exec -T core python - <<'PY'
from app import experience, phase7_acceptance, proactive
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
status = phase7_acceptance.acceptance_status()
inbox = experience.agent_inbox()
search = experience.personal_search("alfred", 3)
notifications = experience.notifications()
after = counts()
paths = {route.path for route in proactive.router.routes}

assert status.get("mode") == "phase7_personal_agent_experience_acceptance_v1"
assert status.get("accepted") is True, status.get("failed_checks")
assert status.get("failed_checks") == []
assert status.get("check_count") == 11
assert status.get("executor_hooks_added") is False
assert status.get("policy_changes") is False
assert status.get("automatic_external_mutations") is False
assert inbox.get("mode") == "agent_inbox_v1"
assert inbox.get("raw_forwarded_body_exposed") is False
assert inbox.get("tool_arguments_exposed") is False
assert inbox.get("tool_results_exposed") is False
assert search.get("mode") == "personal_search_local_first_v1"
assert search.get("cloud_models") is False
assert notifications.get("mode") == "event_driven_attention_v1"
assert notifications.get("daily_briefing") is False
assert before == after, (before, after)

for path in (
    "/v1/core/experience/status",
    "/v1/core/experience/inbox",
    "/v1/core/experience/search",
    "/v1/core/experience/notifications",
    "/v1/core/experience/command",
    "/v1/core/phase7/status",
):
    assert path in paths, path

print("PASS: Phase 7A phone and Mac surfaces share the authoritative Core")
print("PASS: Phase 7B Ask Alfred command facade delegates to existing orchestration")
print("PASS: Phase 7C attention is event-driven and does not create daily briefings")
print("PASS: Phase 7D connected context remains on the existing integration path")
print("PASS: Phase 7E Alfred Inbox is derived and content-minimised")
print("PASS: Phase 7F reviewed capture and exact-scope approval are preserved")
print("PASS: Phase 7G personal search is local-first with no cloud model")
print("PASS: Phase 7H acceptance preserves Phase 5/6 executor and policy boundaries")
print("PASS: Reading Phase 7 status/inbox/search/attention creates no execution or approval state")
print()
print("Phase 7 state:")
print(f"  mode: {status.get('mode')}")
print(f"  accepted: {str(bool(status.get('accepted'))).lower()}")
print(f"  checks: {status.get('check_count')}")
print(f"  needs you: {inbox.get('counts', {}).get('needs_you')}")
print(f"  working: {inbox.get('counts', {}).get('working')}")
print(f"  done: {inbox.get('counts', {}).get('done')}")
print(f"  local search results: {search.get('count')}")
PY

echo
echo "=== PHASE 7 ADVERSARIAL ACCEPTANCE ==="
sudo docker compose run --rm --no-deps \
  -v /opt/alfred-node/core/test_phase7_experience.py:/app/test_phase7_experience.py:ro \
  -v /opt/alfred-node/core/test_phase7_acceptance.py:/app/test_phase7_acceptance.py:ro \
  core python -m unittest test_phase7_experience test_phase7_acceptance -v

echo
echo "Phase 7 acceptance completed using temporary test stores."
echo "No live approval was resolved, no command was submitted and no external mutation was performed by this smoke."

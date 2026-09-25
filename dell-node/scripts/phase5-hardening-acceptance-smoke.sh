#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

echo "=== PHASE 5I FINAL CONTRACT ==="

sudo docker compose exec -T core python - <<'PY'
import json

from app import hardening_acceptance, proactive
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
state = hardening_acceptance.acceptance_status()
after = counts()
paths = {route.path for route in proactive.router.routes}
encoded = json.dumps(state, sort_keys=True).casefold()

assert state.get("mode") == "phase5_hardening_acceptance_v1"
assert state.get("accepted") is True, state.get("failed_checks")
assert state.get("failed_checks") == []
assert state.get("check_count", 0) >= 20
assert state.get("content_policy") == "metadata_only"
assert state.get("raw_arguments_exposed") is False
assert state.get("tool_results_exposed") is False
assert state.get("connected_content_exposed") is False
assert state.get("secret_values_exposed") is False
assert state.get("mutations") is False
assert state.get("executor_hooks_added") is False
assert state.get("cloud_models") is False
assert state.get("adversarial_suite") == "phase5i_test_and_live_smoke_required"
assert before == after, (before, after)
assert "/v1/core/hardening/status" in paths

expected_modes = {
    "5A": "durable_goals_v1",
    "5B": "bounded_agent_loop_v1",
    "5C": "verified_multi_tool_workflows_v1",
    "5D": "goal_aware_exact_scope_v1",
    "5E": "verified_execution_recovery_v1",
    "5F": "controlled_browser_v1",
    "5G": "reusable_workflows_v1",
    "5H": "agent_observability_v1",
}
assert state.get("phase_modes") == expected_modes
assert all(item.get("passed") is True for item in state.get("checks", []))

for forbidden in (
    '"arguments"', '"result"', '"scope_hash"', '"parameter_hash"',
    "authorization: bearer", "refresh_token", "password_value",
):
    assert forbidden not in encoded, forbidden

print("PASS: Phase 5A-5H accepted modes are simultaneously active")
print("PASS: Final contract preserves exact-scope approvals, verified handoffs and mutation replay protection")
print("PASS: Browser private-network, sensitive-field and submission boundaries remain enforced")
print("PASS: Recipes cannot invent submit/send actions and observability remains read-only metadata")
print("PASS: Forbidden high-risk send/file/browser/shell actions are absent")
print("PASS: Reading the Phase 5I contract creates no execution, approval, receipt, goal or recipe state")
print()
print("Phase 5 hardening state:")
print(f"  mode: {state.get('mode')}")
print(f"  accepted: {str(bool(state.get('accepted'))).lower()}")
print(f"  checks: {state.get('check_count')}")
print(f"  failed checks: {len(state.get('failed_checks', []))}")
print(f"  content policy: {state.get('content_policy')}")
print(f"  mutations: {str(bool(state.get('mutations'))).lower()}")
print(f"  cloud models: {str(bool(state.get('cloud_models'))).lower()}")
PY

echo
echo "=== CORE ADVERSARIAL ACCEPTANCE ==="
sudo docker compose exec -T core \
  python -m unittest test_phase5_hardening_acceptance.py -v

echo
echo "=== BROWSER ADVERSARIAL ACCEPTANCE ==="
sudo docker compose --profile browser run --rm --no-deps browser-worker \
  python -m unittest test_policy.py -v

echo
echo "Phase 5I acceptance completed using temporary test stores and policy fixtures."
echo "No live website was opened, no approval was resolved in the live store and no external mutation was performed."

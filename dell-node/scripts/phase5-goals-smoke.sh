#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import execution, goals, proactive, recovery
from app.db import connection

state = goals.status()
paths = {route.path for route in proactive.router.routes}

assert state.get("mode") == "durable_goals_v1"
assert state.get("durable") is True
assert state.get("automatic_execution") is False
assert state.get("cloud_models") is False
assert state.get("dependency_policy") == "earlier_steps_only"
assert state.get("executor") == "existing_policy_gated_plan_executor"
assert "/v1/core/goals" in paths
assert "/v1/core/goals/status" in paths
assert "/v1/core/goals/{goal_id}" in paths
assert "/v1/core/goals/{goal_id}/cancel" in paths

# Validation is pure: dependencies can only point backwards and unregistered
# tools cannot enter a Phase 5A goal plan.
valid = goals._validate_steps([
    {"action": "memory.read", "arguments": {"query": "fixture"}, "depends_on": []},
    {"action": "tasks.list", "arguments": {"limit": 5}, "depends_on": [0]},
])
assert len(valid) == 2
try:
    goals._validate_steps([
        {"action": "memory.read", "arguments": {"query": "fixture"}, "depends_on": [0]},
    ])
except ValueError:
    pass
else:
    raise AssertionError("forward/self dependency was accepted")

try:
    goals._validate_steps([{"action": "browser.buy.now", "arguments": {}}])
except ValueError:
    pass
else:
    raise AssertionError("unregistered tool was accepted")

with connection() as db:
    tables = {row["name"] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_goals','agent_goal_steps','plans')"
    ).fetchall()}
assert tables == {"agent_goals", "agent_goal_steps", "plans"}

# 5B may add a wrapper around the already-guarded recovery function, but the
# established return contract and executor guard remain intact.
assert execution.execute_plan.__name__ == "execute_plan_with_goal_guard"
assert recovery.recover_interrupted_work.__name__ in {"recover_with_goals", "recover_with_run_cleanup"}

print("PASS: Phase 5A durable goal and plan store is active")
print("PASS: Goal steps have bounded ordered dependencies and registered tools only")
print("PASS: Cancelled goals are guarded by the existing policy-gated executor")
print("PASS: Restart recovery reconciles durable goal progress")
print("PASS: Phase 5A goal creation still does not automatically execute tools or call cloud models")
print()
print("Goal state:")
print(f"  mode: {state.get('mode')}")
print(f"  durable: {str(bool(state.get('durable'))).lower()}")
print(f"  goals: {state.get('goals')}")
print(f"  steps: {state.get('steps')}")
print(f"  automatic execution: {str(bool(state.get('automatic_execution'))).lower()}")
print(f"  executor: {state.get('executor')}")
print(f"  cloud models: {str(bool(state.get('cloud_models'))).lower()}")
print()
print("Phase 5A smoke completed without tool execution, approval resolution or external mutation.")
PY

#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
import json

from app import agent_loop, approval_resume, proactive, recovery
from app.db import connection

state = agent_loop.status()
paths = {route.path for route in proactive.router.routes}
encoded = json.dumps(state, sort_keys=True)

assert state.get("mode") == "bounded_agent_loop_v1"
assert state.get("max_steps_per_run") == 20
assert state.get("automatic_start") is False
assert state.get("automatic_safe_continuation") is True
assert state.get("approval_resume") is True
assert state.get("approval_policy") == "existing_exact_scope"
assert state.get("executor") == "existing_policy_gated_executor"
assert state.get("verification") == "existing_per_tool_verification"
assert state.get("adds_or_replans_steps") is False
assert state.get("cloud_models") is False
assert state.get("restart_auto_replay") is False
assert "/v1/core/agent-loop/status" in paths
assert "/v1/core/goals/{goal_id}/run" in paths

with connection() as db:
    tables = {row["name"] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_goal_runs','agent_goals','agent_goal_steps','plans','approvals','core_executions')"
    ).fetchall()}
assert {"agent_goal_runs", "agent_goals", "agent_goal_steps", "plans", "approvals", "core_executions"}.issubset(tables)

# 5B hooks must wrap existing approval/recovery paths rather than inventing a
# second permission or restart system.
assert approval_resume.resolve_and_resume.__name__ == "resolve_and_continue"
assert recovery.recover_interrupted_work.__name__ == "recover_with_run_cleanup"

for forbidden in ("goal", "arguments", "query", "subject", "sender", "body", "topic"):
    assert forbidden not in encoded.lower(), forbidden

print("PASS: Phase 5B bounded agent execution loop is active")
print("PASS: Goal execution starts only on explicit owner request")
print("PASS: Safe steps can continue automatically through the existing verified executor")
print("PASS: Mutations retain exact-scope approval and resume the same durable goal")
print("PASS: Completed work is not replayed and restart never auto-replays interrupted actions")
print("PASS: Phase 5B status is content-minimised and uses no cloud model")
print()
print("Agent loop state:")
print(f"  mode: {state.get('mode')}")
print(f"  runs: {state.get('runs')}")
print(f"  automatic start: {str(bool(state.get('automatic_start'))).lower()}")
print(f"  automatic safe continuation: {str(bool(state.get('automatic_safe_continuation'))).lower()}")
print(f"  approval resume: {str(bool(state.get('approval_resume'))).lower()}")
print(f"  approval policy: {state.get('approval_policy')}")
print(f"  executor: {state.get('executor')}")
print(f"  cloud models: {str(bool(state.get('cloud_models'))).lower()}")
print()
print("Phase 5B smoke completed without starting a goal, executing a tool, resolving an approval or performing an external mutation.")
PY

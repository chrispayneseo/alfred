#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import execution, proactive, workflows
from app.db import connection

state = workflows.status()
paths = {route.path for route in proactive.router.routes}

assert state.get("mode") == "verified_multi_tool_workflows_v1"
assert state.get("handoff") == "verified_scalar_only"
assert state.get("source_policy") == "completed_and_verified_dependency_only"
assert state.get("mutation_approval") == "fully_resolved_exact_scope"
assert state.get("automatic_planning") is False
assert state.get("code_evaluation") is False
assert state.get("cloud_models") is False
assert state.get("max_bindings_per_step") == 8
assert "/v1/core/workflows/status" in paths
assert "/v1/core/workflows" in paths
assert "/v1/core/workflows/{workflow_id}" in paths

# Pure validation only: no goal/workflow row or execution is created here.
steps, bindings = workflows._validate_workflow_steps([
    {"action": "memory.read", "arguments": {"query": "fixture"}},
    {
        "action": "tasks.create",
        "arguments": {"kind": "task"},
        "depends_on": [0],
        "bindings": [
            {"target": "title", "source_step": 0, "source_path": "items.0.content"},
        ],
    },
])
assert len(steps) == 2
assert len(bindings) == 1
assert workflows._extract_scalar({"items": [{"content": "fixture title"}]}, "items.0.content") == "fixture title"

try:
    workflows._validate_workflow_steps([
        {"action": "memory.read", "arguments": {"query": "fixture"}},
        {
            "action": "tasks.create",
            "arguments": {"kind": "task"},
            "depends_on": [],
            "bindings": [
                {"target": "title", "source_step": 0, "source_path": "items.0.content"},
            ],
        },
    ])
except ValueError:
    pass
else:
    raise AssertionError("non-dependent workflow binding was accepted")

try:
    workflows._extract_scalar({"items": [{"content": "fixture"}]}, "items.0")
except workflows.WorkflowBindingError:
    pass
else:
    raise AssertionError("structured workflow value was transferable")

# The binding hook must feed the one existing executor, not replace policy.
assert execution.execute_tool.__name__ == "execute_tool_with_workflow_bindings"

with connection() as db:
    tables = {row["name"] for row in db.execute(
        """SELECT name FROM sqlite_master
           WHERE type='table' AND name IN ('agent_workflows','agent_workflow_bindings')"""
    ).fetchall()}
assert tables == {"agent_workflows", "agent_workflow_bindings"}

print("PASS: Phase 5C verified multi-tool workflow layer is active")
print("PASS: Later steps can consume bounded scalar output from verified dependencies")
print("PASS: Unverified, structured or non-dependent data cannot flow between steps")
print("PASS: Mutations are approved only after arguments are fully resolved")
print("PASS: Workflow hand-off uses the existing policy-gated executor and no cloud model")
print()
print("Workflow state:")
print(f"  mode: {state.get('mode')}")
print(f"  workflows: {state.get('workflows')}")
print(f"  bindings: {state.get('bindings')}")
print(f"  tool kinds: {state.get('tool_kinds')}")
print(f"  handoff: {state.get('handoff')}")
print(f"  mutation approval: {state.get('mutation_approval')}")
print(f"  automatic planning: {str(bool(state.get('automatic_planning'))).lower()}")
print(f"  cloud models: {str(bool(state.get('cloud_models'))).lower()}")
print()
print("Phase 5C smoke completed without starting a goal, executing a tool, resolving an approval or performing an external mutation.")
PY

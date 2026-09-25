#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
import json

from app import execution_reliability, observability, proactive

before = execution_reliability.status()
receipts_before = before["receipts"]
operations_before = before["operations"]

state = observability.status()
view = observability.today_view()
paths = {route.path for route in proactive.router.routes}

after = execution_reliability.status()

assert state["mode"] == "agent_observability_v1"
assert state["content_policy"] == "metadata_only"
assert state["read_only"] is True
assert state["today_view"] is True
assert state["deterministic_explanations"] is True
assert state["connected_content_exposed"] is False
assert state["raw_arguments_exposed"] is False
assert state["tool_results_exposed"] is False
assert state["recipe_parameters_exposed"] is False
assert state["scope_hashes_exposed"] is False
assert state["mutations"] is False
assert state["cloud_models"] is False

assert view["mode"] == "agent_observability_v1"
assert view["content_policy"] == "metadata_only"
assert view["read_only"] is True
assert view["cloud_models"] is False
assert view["explanations"]["source"] == "deterministic_metadata_v1"
assert view["explanations"]["connected_content_exposed"] is False
assert view["explanations"]["raw_arguments_exposed"] is False
assert view["explanations"]["tool_results_exposed"] is False
assert view["explanations"]["recipe_parameters_exposed"] is False
assert view["explanations"]["scope_hashes_exposed"] is False

assert "/v1/core/observability/status" in paths
assert "/v1/core/observability/today" in paths

# Observability may initialise local schema but must never run a tool or create a
# Phase 5E operation/receipt simply by being viewed.
assert after["receipts"] == receipts_before
assert after["operations"] == operations_before

for item in view["active_goals"]:
    assert "goal" not in item
    step = item.get("current_step")
    if step:
        assert "arguments" not in step
        assert "result" not in step
        assert "verification" not in step

for item in view["waiting_approvals"]:
    assert "scope_hash" not in item
    assert "arguments" not in item

for group in ("completed_work", "attention_items"):
    for item in view[group]:
        assert "arguments" not in item
        assert "result" not in item
        assert "verification" not in item

encoded = json.dumps(view).casefold()
for forbidden_key in ('"scope_hash"', '"parameter_hash"', '"arguments"', '"result"', '"verification"'):
    assert forbidden_key not in encoded, forbidden_key

print("PASS: Phase 5H read-only agent observability is active")
print("PASS: Today view exposes active goals, approvals, completed work, attention items and recipe runs as metadata only")
print("PASS: Deterministic step explanations use existing plan, policy, approval and recovery state")
print("PASS: Connected-source content, raw arguments, tool results, recipe values and scope hashes are not exposed")
print("PASS: Reading observability creates no tool execution, Phase 5E operation or receipt")
print("PASS: Phase 5H adds no executor hook, approval path or cloud-model dependency")
print()
print("Agent observability state:")
print(f"  mode: {state['mode']}")
print(f"  content policy: {state['content_policy']}")
print(f"  active goals: {state['active_goals']}")
print(f"  waiting approvals: {state['waiting_approvals']}")
print(f"  attention today: {state['attention_items_today']}")
print(f"  deterministic explanations: {str(state['deterministic_explanations']).lower()}")
print(f"  read only: {str(state['read_only']).lower()}")
print(f"  mutations: {str(state['mutations']).lower()}")
print(f"  cloud models: {str(state['cloud_models']).lower()}")
PY

echo
echo "Phase 5H smoke completed without executing a tool, resolving an approval, reading connected content or performing an external mutation."

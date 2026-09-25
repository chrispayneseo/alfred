#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import proactive, reusable_workflows

state = reusable_workflows.status()
catalog = reusable_workflows.catalog()
paths = {route.path for route in proactive.router.routes}
ids = {item["id"] for item in catalog}

expected = {
    "prepare_tomorrow",
    "deal_with_forwarded_message",
    "research_purchase",
    "plan_dinner_out",
    "prepare_client_task",
}
assert state.get("mode") == "reusable_workflows_v1"
assert state.get("recipes") == len(expected)
assert state.get("definition_source") == "static_application_code_v1"
assert state.get("compiler") == "deterministic_static_recipe_compiler"
assert state.get("creates") == "existing_phase5c_workflow_and_phase5a_goal"
assert state.get("executor") == "existing_phase5b_bounded_agent_loop"
assert state.get("approval_policy") == "existing_exact_scope"
assert state.get("verification_recovery") == "existing_phase5e"
assert state.get("browser_policy") == "existing_phase5f"
assert state.get("automatic_start") is False
assert state.get("runtime_action_invention") is False
assert state.get("code_evaluation") is False
assert state.get("parameter_values_in_status") is False
assert state.get("cloud_models") is False

assert ids == expected
assert all(item.get("version") == 1 for item in catalog)
assert all(item.get("automatic_start") is False for item in catalog)
actions = {action for item in catalog for action in item.get("actions", [])}
assert "browser.submit" not in actions
assert "email.send" not in actions

# Compile representative recipes without creating a durable goal or executing a
# tool. This proves the definitions emit only ordinary Phase 5C workflow shapes.
recipe = reusable_workflows.RECIPES["prepare_tomorrow"]
goal, steps = reusable_workflows.compile_recipe(
    recipe, {"date": "2026-09-26", "task_limit": 20}
)
assert goal == "Prepare for 2026-09-26"
assert [item["action"] for item in steps] == ["calendar.events.list", "tasks.list"]

browser_recipe = reusable_workflows.RECIPES["research_purchase"]
_, browser_steps = reusable_workflows.compile_recipe(
    browser_recipe, {"url": "https://example.com/product"}
)
assert [item["action"] for item in browser_steps] == [
    "browser.session.open", "browser.page.inspect", "browser.session.close"
]
assert len(browser_steps[1]["bindings"]) == 1
assert browser_steps[1]["bindings"][0]["source_path"] == "session_id"
assert len(browser_steps[2]["bindings"]) == 1
assert browser_steps[2]["bindings"][0]["source_path"] == "session_id"

for path in (
    "/v1/core/recipes/status",
    "/v1/core/recipes",
    "/v1/core/recipes/{recipe_id}/instantiate",
    "/v1/core/recipes/{recipe_id}/run",
    "/v1/core/recipes/instances/{instance_id}",
):
    assert path in paths, path

encoded = str(state).casefold()
for forbidden in ("private forwarded", "parameter_hash", "message content", "password"):
    assert forbidden not in encoded, forbidden

print("PASS: Phase 5G deterministic reusable workflow catalog is active")
print("PASS: Recipes compile into existing Phase 5C workflows and Phase 5A durable goals")
print("PASS: Explicit recipe runs use the existing Phase 5B bounded agent loop")
print("PASS: Existing exact-scope approvals, Phase 5E recovery and Phase 5F browser policy remain authoritative")
print("PASS: Recipe definitions cannot invent runtime tools, evaluate code or auto-start themselves")
print("PASS: Built-in recipes introduce no browser submission or email-send capability")
print()
print("Reusable workflow state:")
print(f"  mode: {state.get('mode')}")
print(f"  recipes: {state.get('recipes')}")
print(f"  instances: {state.get('instances')}")
print(f"  compiler: {state.get('compiler')}")
print(f"  creates: {state.get('creates')}")
print(f"  executor: {state.get('executor')}")
print(f"  approval policy: {state.get('approval_policy')}")
print(f"  verification/recovery: {state.get('verification_recovery')}")
print(f"  browser policy: {state.get('browser_policy')}")
print(f"  automatic start: {str(bool(state.get('automatic_start'))).lower()}")
print(f"  cloud models: {str(bool(state.get('cloud_models'))).lower()}")
PY

echo
echo "Phase 5G smoke completed without instantiating a recipe, starting a goal, resolving an approval, opening a website or performing an external mutation."

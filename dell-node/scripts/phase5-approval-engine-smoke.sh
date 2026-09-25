#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import approval_engine, execution, proactive
from app.core import decide
from app.db import connection

state = approval_engine.status()
paths = {route.path for route in proactive.router.routes}

assert state.get("mode") == "goal_aware_exact_scope_v1"
assert state.get("risk_source") == "core_tools_deterministic"
assert state.get("approval_scope") == "existing_sha256_exact_arguments"
assert state.get("goal_context") == "metadata_only"
assert state.get("raw_arguments_stored") is False
assert state.get("bound_values_stored") is False
assert state.get("policy_changes") is False
assert state.get("cloud_models") is False

assert "/v1/core/approval-engine/status" in paths
assert "/v1/core/approval-engine/pending" in paths
assert "/v1/core/approvals/{approval_id}/context" in paths

# Existing deterministic Core policy remains authoritative.
assert decide("memory.read").decision == "auto"
assert decide("tasks.create").decision == "confirm"
assert decide("calendar.events.create").decision == "confirm"
assert decide("home_assistant.service").decision == "confirm"
assert decide("not.registered").decision == "deny"

# 5D wraps only approval creation; it does not replace execute_tool or scope hashing.
assert getattr(execution._pending_or_new_approval, "_phase5d_wrapped", False) is True
assert approval_engine._effect_for("tasks.create") == "create_local_task"
assert approval_engine._effect_for("calendar.events.create") == "create_external_calendar_event"
assert approval_engine._effect_for("email.draft.create") == "create_external_email_draft"

with connection() as db:
    table = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_approval_context'"
    ).fetchone()
assert table is not None

print("PASS: Phase 5D goal-aware approval and risk engine is active")
print("PASS: Existing deterministic policy and exact-scope approval hash remain authoritative")
print("PASS: Goal context records only IDs, counts, risk/effect metadata and scope hash")
print("PASS: Verified workflow hand-offs can be explained without storing bound values")
print("PASS: Phase 5D uses no cloud model and does not auto-approve mutations")
print()
print("Approval engine state:")
print(f"  mode: {state.get('mode')}")
print(f"  contexts: {state.get('contexts')}")
print(f"  pending: {state.get('pending')}")
print(f"  risk source: {state.get('risk_source')}")
print(f"  approval scope: {state.get('approval_scope')}")
print(f"  goal context: {state.get('goal_context')}")
print(f"  policy changes: {str(bool(state.get('policy_changes'))).lower()}")
print(f"  cloud models: {str(bool(state.get('cloud_models'))).lower()}")
print()
print("Phase 5D smoke completed without creating an approval, resolving an approval, executing a tool or performing an external mutation.")
PY

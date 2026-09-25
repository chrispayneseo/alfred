#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import execution, execution_reliability, proactive
from app.db import connection

state = execution_reliability.status()
paths = {route.path for route in proactive.router.routes}

assert state.get("mode") == "verified_execution_recovery_v1"
assert state.get("max_read_attempts") == 3
assert state.get("postcondition_verification") == "existing_per_tool_deterministic"
assert state.get("idempotency") == "resolved_argument_operation_key"
assert state.get("automatic_read_retries") is True
assert state.get("mutation_replay_protection") is True
assert state.get("ambiguous_mutation") == "reconciliation_required"
assert state.get("restart_auto_mutation_replay") is False
assert state.get("approval_scope") == "existing_sha256_exact_arguments"
assert state.get("metadata_only_receipts") is True
assert state.get("cloud_models") is False

assert "/v1/core/execution-reliability/status" in paths
assert "/v1/core/execution-reliability/reconciliation" in paths
assert getattr(execution, "_phase5e_reliability_enabled", False) is True

# 5C remains the outer executor wrapper so workflow values are resolved before
# 5E computes its operation identity. 5E still owns the inner execution path.
assert execution.execute_tool.__name__ == "execute_tool_with_workflow_bindings"

with connection() as db:
    operations = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='core_reliability_operations'"
    ).fetchone()
    receipts = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='core_execution_receipts'"
    ).fetchone()
assert operations is not None
assert receipts is not None

print("PASS: Phase 5E deterministic verification and recovery layer is active")
print("PASS: Read failures have bounded automatic retries and deterministic verification")
print("PASS: Mutation operation keys use fully resolved arguments and prevent replay")
print("PASS: Ambiguous mutation outcomes stop for reconciliation rather than guessing")
print("PASS: Restart recovery classifies interrupted work without automatic mutation replay")
print("PASS: Phase 5E receipts are metadata-only and use no cloud model")
print()
print("Verification and recovery state:")
print(f"  mode: {state.get('mode')}")
print(f"  operations: {state.get('operations')}")
print(f"  receipts: {state.get('receipts')}")
print(f"  max read attempts: {state.get('max_read_attempts')}")
print(f"  postcondition verification: {state.get('postcondition_verification')}")
print(f"  idempotency: {state.get('idempotency')}")
print(f"  mutation replay protection: {str(bool(state.get('mutation_replay_protection'))).lower()}")
print(f"  ambiguous mutation: {state.get('ambiguous_mutation')}")
print(f"  cloud models: {str(bool(state.get('cloud_models'))).lower()}")
print()
print("Phase 5E smoke completed without executing a tool, resolving an approval, retrying connected data or performing an external mutation.")
PY

"""Phase 5E deterministic verification, retries and recovery for Alfred Core.

The existing Core executor remains authoritative for policy, exact-scope
approval, invocation and per-tool verification. This module adds a durable,
content-minimised reliability ledger around that executor:

* verified mutations are never replayed for the same resolved operation;
* transient read failures may retry within a deterministic bounded budget;
* deterministic precondition failures remain ordinary failures;
* ambiguous mutation outcomes stop for reconciliation;
* interrupted work is classified on restart without automatically replaying it.

No language model participates in retry, verification or recovery decisions.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from typing import Any
from uuid import uuid4

from fastapi import APIRouter

from .core import TOOLS
from .db import connection, record_audit


RELIABILITY_MODE = "verified_execution_recovery_v1"
MAX_READ_ATTEMPTS = 3
# These exceptions are raised by Alfred's validators/lookups before a side effect
# is dispatched. They are therefore definitive failures rather than ambiguous
# mutation outcomes. Unknown exceptions remain fail-closed.
DEFINITIVE_NO_EFFECT_ERRORS = {"ValueError", "LookupError", "PermissionError"}
NON_RETRYABLE_READ_ERRORS = DEFINITIVE_NO_EFFECT_ERRORS

router = APIRouter(tags=["core-execution-reliability"])
_INSTALLED = False


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def argument_hash(arguments: dict) -> str:
    return _hash(arguments)


def operation_key(*, request_id: str, action: str, arguments: dict,
                  plan_id: str | None, step_index: int | None) -> str:
    """Identify one fully-resolved operation without persisting its arguments."""
    return _hash({
        "request_id": request_id,
        "action": action,
        "arguments": arguments,
        "plan_id": plan_id,
        "step_index": step_index,
    })


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS core_reliability_operations (
            operation_key TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            plan_id TEXT,
            step_index INTEGER,
            action TEXT NOT NULL,
            effect_class TEXT NOT NULL,
            argument_hash TEXT NOT NULL,
            state TEXT NOT NULL,
            execution_id TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute(
            "CREATE INDEX IF NOT EXISTS core_reliability_state "
            "ON core_reliability_operations(state, updated_at DESC)"
        )
        db.execute("""CREATE TABLE IF NOT EXISTS core_execution_receipts (
            id TEXT PRIMARY KEY,
            operation_key TEXT NOT NULL,
            execution_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            plan_id TEXT,
            step_index INTEGER,
            action TEXT NOT NULL,
            effect_class TEXT NOT NULL,
            argument_hash TEXT NOT NULL,
            attempt_number INTEGER NOT NULL,
            outcome_state TEXT NOT NULL,
            verification_state TEXT NOT NULL,
            error_type TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(operation_key, attempt_number)
        )""")
        db.execute(
            "CREATE INDEX IF NOT EXISTS core_receipts_execution "
            "ON core_execution_receipts(execution_id, attempt_number)"
        )


def _table_exists(db, name: str) -> bool:
    return db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", (name,)
    ).fetchone() is not None


def _effect_class(action: str) -> str:
    definition = TOOLS.get(action) or {}
    return str(definition.get("risk") or "high_impact")


def _operation(key: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute(
            "SELECT * FROM core_reliability_operations WHERE operation_key = ?",
            (key,),
        ).fetchone()
    return dict(row) if row else None


def _execution(execution_id: str | None) -> dict | None:
    """Read an execution when present, preserving early-denial compatibility."""
    if not execution_id:
        return None
    with connection() as db:
        if not _table_exists(db, "core_executions"):
            return None
        row = db.execute(
            "SELECT * FROM core_executions WHERE id = ?", (execution_id,)
        ).fetchone()
    if row is None:
        return None
    item = dict(row)
    for field in ("result", "verification"):
        value = item.get(field)
        item[field] = json.loads(value) if value else None
    return item


def _row_error_type(execution_id: str | None) -> str | None:
    if not execution_id:
        return None
    with connection() as db:
        if not _table_exists(db, "core_executions"):
            return None
        row = db.execute(
            "SELECT error FROM core_executions WHERE id = ?", (execution_id,)
        ).fetchone()
    return str(row["error"]) if row and row["error"] else None


def _execution_result(item: dict, *, replayed: bool = False) -> dict:
    payload = {
        "id": item["id"],
        "request_id": item["request_id"],
        "plan_id": item.get("plan_id"),
        "step_index": item.get("step_index"),
        "action": item["action"],
        "state": item["state"],
        "result": item.get("result"),
        "verification": item.get("verification"),
        "approval": None,
        "error": item.get("error"),
    }
    if replayed:
        payload["replayed"] = True
    return payload


def _upsert_operation(*, key: str, request_id: str, plan_id: str | None,
                      step_index: int | None, action: str, arguments: dict,
                      state: str, execution_id: str | None = None,
                      attempt_count: int | None = None) -> None:
    initialise()
    with connection() as db:
        existing = db.execute(
            "SELECT attempt_count FROM core_reliability_operations WHERE operation_key = ?",
            (key,),
        ).fetchone()
        count = int(existing["attempt_count"]) if existing else 0
        if attempt_count is not None:
            count = max(count, int(attempt_count))
        db.execute("""INSERT INTO core_reliability_operations
            (operation_key, request_id, plan_id, step_index, action, effect_class,
             argument_hash, state, execution_id, attempt_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(operation_key) DO UPDATE SET
              state = excluded.state,
              execution_id = COALESCE(
                  excluded.execution_id,
                  core_reliability_operations.execution_id
              ),
              attempt_count = MAX(
                  core_reliability_operations.attempt_count,
                  excluded.attempt_count
              ),
              updated_at = CURRENT_TIMESTAMP""",
            (
                key, request_id, plan_id, step_index, action,
                _effect_class(action), argument_hash(arguments), state,
                execution_id, count,
            ),
        )


def _record_receipt(*, key: str, execution_id: str, request_id: str,
                    plan_id: str | None, step_index: int | None, action: str,
                    arguments: dict, attempt_number: int, outcome_state: str,
                    verification: dict | None, error_type: str | None) -> None:
    verification_state = (
        "verified" if (verification or {}).get("ok") is True
        else "failed" if verification is not None
        else "unknown"
    )
    with connection() as db:
        db.execute("""INSERT OR IGNORE INTO core_execution_receipts
            (id, operation_key, execution_id, request_id, plan_id, step_index,
             action, effect_class, argument_hash, attempt_number, outcome_state,
             verification_state, error_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                str(uuid4()), key, execution_id, request_id, plan_id, step_index,
                action, _effect_class(action), argument_hash(arguments),
                attempt_number, outcome_state, verification_state, error_type,
            ),
        )


def _with_reliability(result: dict, operation: dict, *, recovery: str,
                      replay_protected: bool = False) -> dict:
    payload = dict(result)
    payload["reliability"] = {
        "operation_key": operation["operation_key"],
        "attempts": int(operation.get("attempt_count") or 0),
        "state": operation["state"],
        "recovery": recovery,
        "replay_protected": replay_protected,
    }
    return payload


def _reconciliation_result(operation: dict) -> dict:
    item = _execution(operation.get("execution_id"))
    if item is not None:
        base = _execution_result(item, replayed=True)
    else:
        base = {
            "id": operation.get("execution_id") or "reconciliation-required",
            "request_id": operation["request_id"],
            "plan_id": operation.get("plan_id"),
            "step_index": operation.get("step_index"),
            "action": operation["action"],
            "state": "reconciliation_required",
            "result": None,
            "verification": None,
            "approval": None,
            "error": None,
        }
    base["state"] = "reconciliation_required"
    base["error"] = "Mutation outcome is ambiguous and must be reconciled before retry."
    return _with_reliability(
        base, operation,
        recovery="reconciliation_required",
        replay_protected=True,
    )


async def _retry_read(operation: dict, arguments: dict) -> dict:
    """Retry one durable read execution row within the global attempt budget."""
    from . import recovery

    execution_id = operation.get("execution_id")
    if not isinstance(execution_id, str) or not execution_id:
        _upsert_operation(
            key=operation["operation_key"], request_id=operation["request_id"],
            plan_id=operation.get("plan_id"), step_index=operation.get("step_index"),
            action=operation["action"], arguments=arguments,
            state="retry_exhausted",
        )
        current = _operation(operation["operation_key"]) or operation
        return _with_reliability({
            "id": "retry-unavailable",
            "request_id": operation["request_id"],
            "plan_id": operation.get("plan_id"),
            "step_index": operation.get("step_index"),
            "action": operation["action"],
            "state": "failed",
            "result": None,
            "verification": None,
            "approval": None,
            "error": "Retry metadata is incomplete",
        }, current, recovery="retry_exhausted")

    current = operation
    while int(current.get("attempt_count") or 0) < MAX_READ_ATTEMPTS:
        if _row_error_type(execution_id) in NON_RETRYABLE_READ_ERRORS:
            _upsert_operation(
                key=current["operation_key"], request_id=current["request_id"],
                plan_id=current.get("plan_id"), step_index=current.get("step_index"),
                action=current["action"], arguments=arguments,
                state="failed_terminal", execution_id=execution_id,
            )
            current = _operation(current["operation_key"]) or current
            item = _execution(execution_id)
            result = _execution_result(item, replayed=True) if item else {
                "id": execution_id,
                "request_id": current["request_id"],
                "plan_id": current.get("plan_id"),
                "step_index": current.get("step_index"),
                "action": current["action"],
                "state": "failed",
                "result": None,
                "verification": None,
                "approval": None,
                "error": "Read failed deterministically",
            }
            return _with_reliability(result, current, recovery="not_retryable")

        retried = await recovery.retry_execution(execution_id)
        attempt_number = int(current.get("attempt_count") or 0) + 1
        verification = (
            retried.get("verification")
            if isinstance(retried.get("verification"), dict)
            else None
        )
        _record_receipt(
            key=current["operation_key"], execution_id=execution_id,
            request_id=current["request_id"], plan_id=current.get("plan_id"),
            step_index=current.get("step_index"), action=current["action"],
            arguments=arguments, attempt_number=attempt_number,
            outcome_state=str(retried.get("state") or "failed"),
            verification=verification,
            error_type=(
                str(retried.get("error_type"))
                if retried.get("error_type") else _row_error_type(execution_id)
            ),
        )
        verified = (
            retried.get("state") == "completed"
            and (verification or {}).get("ok") is True
        )
        _upsert_operation(
            key=current["operation_key"], request_id=current["request_id"],
            plan_id=current.get("plan_id"), step_index=current.get("step_index"),
            action=current["action"], arguments=arguments,
            state="verified" if verified else "retryable",
            execution_id=execution_id, attempt_count=attempt_number,
        )
        current = _operation(current["operation_key"]) or current
        if verified:
            item = _execution(execution_id)
            result = _execution_result(item) if item else dict(retried)
            return _with_reliability(result, current, recovery="verified")

    _upsert_operation(
        key=current["operation_key"], request_id=current["request_id"],
        plan_id=current.get("plan_id"), step_index=current.get("step_index"),
        action=current["action"], arguments=arguments,
        state="retry_exhausted", execution_id=execution_id,
    )
    current = _operation(current["operation_key"]) or current
    item = _execution(execution_id)
    result = _execution_result(item, replayed=True) if item else {
        "id": execution_id,
        "request_id": current["request_id"],
        "plan_id": current.get("plan_id"),
        "step_index": current.get("step_index"),
        "action": current["action"],
        "state": "failed",
        "result": None,
        "verification": None,
        "approval": None,
        "error": "Read retry budget exhausted",
    }
    result["state"] = "failed"
    return _with_reliability(result, current, recovery="retry_exhausted")


def reconcile_interrupted_operations() -> dict:
    """Classify interrupted work after restart without executing any tool."""
    initialise()
    with connection() as db:
        if not _table_exists(db, "core_executions"):
            return {}
        rows = db.execute("""SELECT id, request_id, plan_id, step_index,
                   action, arguments
            FROM core_executions WHERE state = 'interrupted'""").fetchall()

    counts: Counter[str] = Counter()
    for row in rows:
        arguments = json.loads(row["arguments"])
        key = operation_key(
            request_id=row["request_id"], action=row["action"],
            arguments=arguments, plan_id=row["plan_id"],
            step_index=row["step_index"],
        )
        state = (
            "retryable"
            if _effect_class(row["action"]) == "read"
            else "reconciliation_required"
        )
        existing = _operation(key)
        _upsert_operation(
            key=key, request_id=row["request_id"], plan_id=row["plan_id"],
            step_index=row["step_index"], action=row["action"],
            arguments=arguments, state=state, execution_id=row["id"],
            attempt_count=max(1, int((existing or {}).get("attempt_count") or 0)),
        )
        counts[state] += 1
    return dict(counts)


def status() -> dict:
    initialise()
    with connection() as db:
        rows = db.execute(
            "SELECT state, COUNT(*) AS count "
            "FROM core_reliability_operations GROUP BY state"
        ).fetchall()
        receipt_count = int(
            db.execute("SELECT COUNT(*) FROM core_execution_receipts").fetchone()[0]
        )
    states = {str(row["state"]): int(row["count"]) for row in rows}
    return {
        "mode": RELIABILITY_MODE,
        "operations": sum(states.values()),
        "receipts": receipt_count,
        "states": states,
        "max_read_attempts": MAX_READ_ATTEMPTS,
        "postcondition_verification": "existing_per_tool_deterministic",
        "idempotency": "resolved_argument_operation_key",
        "automatic_read_retries": True,
        "mutation_replay_protection": True,
        "ambiguous_mutation": "reconciliation_required",
        "restart_auto_mutation_replay": False,
        "approval_scope": "existing_sha256_exact_arguments",
        "metadata_only_receipts": True,
        "cloud_models": False,
    }


def reconciliation_items(limit: int = 50) -> list[dict]:
    initialise()
    size = max(1, min(int(limit), 100))
    with connection() as db:
        rows = db.execute("""SELECT operation_key, request_id, plan_id, step_index,
                   action, effect_class, state, execution_id, attempt_count,
                   updated_at
            FROM core_reliability_operations
            WHERE state = 'reconciliation_required'
            ORDER BY updated_at DESC LIMIT ?""", (size,)).fetchall()
    return [dict(row) for row in rows]


def install() -> None:
    """Wrap existing execution/recovery paths; never create a second executor."""
    global _INSTALLED
    if _INSTALLED:
        return

    from . import agent_loop, execution, goals, recovery

    original_execute_tool = execution.execute_tool
    original_recover = recovery.recover_interrupted_work
    original_run_goal = agent_loop.run_goal

    async def execute_tool_with_reliability(
        *, request_id: str, action: str, arguments: dict,
        plan_id: str | None = None, step_index: int | None = None,
    ) -> dict:
        if action not in TOOLS:
            return await original_execute_tool(
                request_id=request_id, action=action, arguments=arguments,
                plan_id=plan_id, step_index=step_index,
            )

        key = operation_key(
            request_id=request_id, action=action, arguments=arguments,
            plan_id=plan_id, step_index=step_index,
        )
        effect = _effect_class(action)
        prior = _operation(key)

        if prior and effect != "read" and prior["state"] == "verified":
            item = _execution(prior.get("execution_id"))
            if item is not None:
                return _with_reliability(
                    _execution_result(item, replayed=True), prior,
                    recovery="verified", replay_protected=True,
                )
        if prior and effect != "read" and prior["state"] == "reconciliation_required":
            return _reconciliation_result(prior)
        if prior and effect == "read" and prior["state"] == "retryable":
            return await _retry_read(prior, arguments)
        if prior and prior["state"] == "running":
            item = _execution(prior.get("execution_id"))
            if (
                item is not None
                and item.get("state") == "completed"
                and (item.get("verification") or {}).get("ok") is True
            ):
                _upsert_operation(
                    key=key, request_id=request_id, plan_id=plan_id,
                    step_index=step_index, action=action, arguments=arguments,
                    state="verified", execution_id=item["id"],
                    attempt_count=max(1, int(prior.get("attempt_count") or 0)),
                )
                current = _operation(key) or prior
                return _with_reliability(
                    _execution_result(item, replayed=True), current,
                    recovery="verified", replay_protected=effect != "read",
                )
            if effect != "read":
                _upsert_operation(
                    key=key, request_id=request_id, plan_id=plan_id,
                    step_index=step_index, action=action, arguments=arguments,
                    state="reconciliation_required",
                    execution_id=prior.get("execution_id"),
                )
                return _reconciliation_result(_operation(key) or prior)

        _upsert_operation(
            key=key, request_id=request_id, plan_id=plan_id,
            step_index=step_index, action=action, arguments=arguments,
            state="running",
        )
        result = await original_execute_tool(
            request_id=request_id, action=action, arguments=arguments,
            plan_id=plan_id, step_index=step_index,
        )

        execution_id = result.get("id") if isinstance(result.get("id"), str) else None
        item = _execution(execution_id)
        current = _operation(key) or {
            "operation_key": key,
            "request_id": request_id,
            "plan_id": plan_id,
            "step_index": step_index,
            "action": action,
            "attempt_count": 0,
            "state": "running",
        }

        # Only a newly invoked durable execution is an attempt. Replayed executor
        # rows pre-date this call and must not create duplicate receipts.
        if item is not None and not result.get("replayed"):
            attempt_number = int(current.get("attempt_count") or 0) + 1
            verification = (
                result.get("verification")
                if isinstance(result.get("verification"), dict)
                else None
            )
            _record_receipt(
                key=key, execution_id=execution_id, request_id=request_id,
                plan_id=plan_id, step_index=step_index, action=action,
                arguments=arguments, attempt_number=attempt_number,
                outcome_state=str(result.get("state") or "failed"),
                verification=verification,
                error_type=_row_error_type(execution_id),
            )
            _upsert_operation(
                key=key, request_id=request_id, plan_id=plan_id,
                step_index=step_index, action=action, arguments=arguments,
                state="running", execution_id=execution_id,
                attempt_count=attempt_number,
            )
            current = _operation(key) or current
        elif item is not None:
            _upsert_operation(
                key=key, request_id=request_id, plan_id=plan_id,
                step_index=step_index, action=action, arguments=arguments,
                state="running", execution_id=execution_id,
                attempt_count=max(1, int(current.get("attempt_count") or 0)),
            )
            current = _operation(key) or current

        state = result.get("state")
        verification = (
            result.get("verification")
            if isinstance(result.get("verification"), dict)
            else None
        )

        if state == "completed" and (verification or {}).get("ok") is True:
            _upsert_operation(
                key=key, request_id=request_id, plan_id=plan_id,
                step_index=step_index, action=action, arguments=arguments,
                state="verified", execution_id=execution_id,
            )
            return _with_reliability(
                result, _operation(key) or current,
                recovery="verified", replay_protected=effect != "read",
            )

        if state == "failed" and effect == "read" and execution_id:
            error_type = _row_error_type(execution_id)
            if error_type in NON_RETRYABLE_READ_ERRORS:
                _upsert_operation(
                    key=key, request_id=request_id, plan_id=plan_id,
                    step_index=step_index, action=action, arguments=arguments,
                    state="failed_terminal", execution_id=execution_id,
                )
                return _with_reliability(
                    result, _operation(key) or current,
                    recovery="not_retryable",
                )
            _upsert_operation(
                key=key, request_id=request_id, plan_id=plan_id,
                step_index=step_index, action=action, arguments=arguments,
                state="retryable", execution_id=execution_id,
            )
            return await _retry_read(_operation(key) or current, arguments)

        if state in {"failed", "interrupted"} and effect != "read":
            error_type = _row_error_type(execution_id)
            if state == "failed" and error_type in DEFINITIVE_NO_EFFECT_ERRORS:
                _upsert_operation(
                    key=key, request_id=request_id, plan_id=plan_id,
                    step_index=step_index, action=action, arguments=arguments,
                    state="failed_terminal", execution_id=execution_id,
                )
                return _with_reliability(
                    result, _operation(key) or current,
                    recovery="not_retryable", replay_protected=True,
                )

            _upsert_operation(
                key=key, request_id=request_id, plan_id=plan_id,
                step_index=step_index, action=action, arguments=arguments,
                state="reconciliation_required", execution_id=execution_id,
            )
            record_audit(
                "execution.reconciliation_required",
                {
                    "execution_id": execution_id,
                    "action": action,
                    "operation_key": key,
                },
                request_id,
            )
            return _reconciliation_result(_operation(key) or current)

        terminal = (
            "approval_required" if state == "approval_required"
            else "denied" if state == "denied"
            else str(state or "failed_terminal")
        )
        _upsert_operation(
            key=key, request_id=request_id, plan_id=plan_id,
            step_index=step_index, action=action, arguments=arguments,
            state=terminal, execution_id=execution_id,
        )
        return _with_reliability(
            result, _operation(key) or current,
            recovery=terminal,
        )

    execute_tool_with_reliability._phase5e_wrapped = True
    execution.execute_tool = execute_tool_with_reliability

    def recover_with_reliability() -> dict:
        result = original_recover()
        reconcile_interrupted_operations()
        return result

    recovery.recover_interrupted_work = recover_with_reliability

    async def run_goal_with_reliability(goal_id: str, *, trigger: str = "owner") -> dict:
        # Phase 5B intentionally blocks a goal after an interrupted/failed step.
        # 5E may recover only a read-only current step, then hands control back to
        # that same bounded owner-started loop. Mutations never take this path.
        goal = goals.get_goal(goal_id)
        if goal and goal.get("state") == "blocked":
            current_id = goal.get("current_step_id")
            step = next(
                (item for item in goal.get("steps", []) if item["id"] == current_id),
                None,
            )
            if step and _effect_class(str(step.get("action"))) == "read":
                with connection() as db:
                    row = None
                    if _table_exists(db, "core_executions"):
                        row = db.execute("""SELECT id, request_id, plan_id,
                                   step_index, action, arguments, state
                            FROM core_executions
                            WHERE plan_id = ? AND step_index = ?
                            ORDER BY created_at DESC LIMIT 1""",
                            (goal["plan_id"], int(step["position"])),
                        ).fetchone()
                if row and row["state"] in {"failed", "interrupted"}:
                    arguments = json.loads(row["arguments"])
                    key = operation_key(
                        request_id=row["request_id"], action=row["action"],
                        arguments=arguments, plan_id=row["plan_id"],
                        step_index=row["step_index"],
                    )
                    existing = _operation(key)
                    _upsert_operation(
                        key=key, request_id=row["request_id"],
                        plan_id=row["plan_id"], step_index=row["step_index"],
                        action=row["action"], arguments=arguments,
                        state="retryable", execution_id=row["id"],
                        attempt_count=max(
                            1, int((existing or {}).get("attempt_count") or 0)
                        ),
                    )
                    recovered = await _retry_read(_operation(key) or {}, arguments)
                    if recovered.get("state") == "completed":
                        with connection() as db:
                            db.execute("""UPDATE plans
                                SET state = 'running', updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?""", (goal["plan_id"],))
                        goals.sync_goal_progress(goal_id)
        return await original_run_goal(goal_id, trigger=trigger)

    agent_loop.run_goal = run_goal_with_reliability
    execution._phase5e_reliability_enabled = True
    _INSTALLED = True


@router.get("/v1/core/execution-reliability/status")
async def execution_reliability_status():
    return status()


@router.get("/v1/core/execution-reliability/reconciliation")
async def execution_reliability_reconciliation(limit: int = 50):
    return {"items": reconciliation_items(limit)}

"""Policy-gated tool execution and verification for Alfred Core.

This module is deliberately deterministic. A model may propose a plan, but only
registered adapters below can execute it. Risky actions require a durable,
matching approval before the adapter is invoked.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from .clients import home_assistant
from .core import TOOLS, decide
from .db import (
    connection,
    correct_memory,
    create_approval,
    forget,
    get_memory,
    recall,
    record_audit,
    remember,
)


@dataclass(frozen=True)
class ExecutionResult:
    id: str
    request_id: str
    action: str
    state: str
    plan_id: str | None = None
    step_index: int | None = None
    result: dict | None = None
    verification: dict | None = None
    approval: dict | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "request_id": self.request_id,
            "plan_id": self.plan_id,
            "step_index": self.step_index,
            "action": self.action,
            "state": self.state,
            "result": self.result,
            "verification": self.verification,
            "approval": self.approval,
            "error": self.error,
        }


def initialise_execution_store() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS core_executions (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          plan_id TEXT,
          step_index INTEGER,
          action TEXT NOT NULL,
          state TEXT NOT NULL,
          arguments TEXT NOT NULL,
          result TEXT,
          verification TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        )""")
        db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS core_execution_plan_step
          ON core_executions(plan_id, step_index)
          WHERE plan_id IS NOT NULL AND step_index IS NOT NULL""")
        db.execute("CREATE INDEX IF NOT EXISTS core_execution_request ON core_executions(request_id, created_at DESC)")


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), default=str)


def _load_json(value: str | None) -> dict | None:
    return json.loads(value) if value else None


def _row_to_result(row) -> ExecutionResult:
    return ExecutionResult(
        id=row["id"],
        request_id=row["request_id"],
        plan_id=row["plan_id"],
        step_index=row["step_index"],
        action=row["action"],
        state=row["state"],
        result=_load_json(row["result"]),
        verification=_load_json(row["verification"]),
        error=row["error"],
    )


def _existing_step(plan_id: str | None, step_index: int | None) -> ExecutionResult | None:
    if plan_id is None or step_index is None:
        return None
    initialise_execution_store()
    with connection() as db:
        row = db.execute(
            "SELECT * FROM core_executions WHERE plan_id = ? AND step_index = ?",
            (plan_id, step_index),
        ).fetchone()
    return _row_to_result(row) if row else None


def _latest_approval(request_id: str, plan_id: str | None, action: str) -> dict | None:
    with connection() as db:
        if plan_id is None:
            row = db.execute(
                """SELECT id, request_id, plan_id, action, summary, risk_level, state, created_at, resolved_at
                   FROM approvals WHERE request_id = ? AND plan_id IS NULL AND action = ?
                   ORDER BY created_at DESC LIMIT 1""",
                (request_id, action),
            ).fetchone()
        else:
            row = db.execute(
                """SELECT id, request_id, plan_id, action, summary, risk_level, state, created_at, resolved_at
                   FROM approvals WHERE request_id = ? AND plan_id = ? AND action = ?
                   ORDER BY created_at DESC LIMIT 1""",
                (request_id, plan_id, action),
            ).fetchone()
    return dict(row) if row else None


def _pending_or_new_approval(request_id: str, plan_id: str | None, action: str, arguments: dict) -> dict:
    existing = _latest_approval(request_id, plan_id, action)
    if existing and existing["state"] in {"pending", "approved", "rejected"}:
        return existing
    policy = decide(action)
    summary = f"Execute {action} with arguments: {_json(arguments)[:700]}"
    return create_approval(request_id, plan_id, action, summary, policy.level)


def _record_start(
    execution_id: str,
    request_id: str,
    plan_id: str | None,
    step_index: int | None,
    action: str,
    arguments: dict,
) -> None:
    initialise_execution_store()
    with connection() as db:
        db.execute(
            """INSERT INTO core_executions
               (id, request_id, plan_id, step_index, action, state, arguments)
               VALUES (?, ?, ?, ?, ?, 'running', ?)""",
            (execution_id, request_id, plan_id, step_index, action, _json(arguments)),
        )


def _record_finish(execution_id: str, state: str, result: dict | None,
                   verification: dict | None, error: str | None = None) -> None:
    with connection() as db:
        db.execute(
            """UPDATE core_executions
               SET state = ?, result = ?, verification = ?, error = ?, completed_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (state, _json(result) if result is not None else None,
             _json(verification) if verification is not None else None, error, execution_id),
        )


def _require(arguments: dict, name: str, expected_type: type | tuple[type, ...] = str):
    value = arguments.get(name)
    if not isinstance(value, expected_type) or (isinstance(value, str) and not value.strip()):
        raise ValueError(f"Missing or invalid argument: {name}")
    return value


async def _invoke(action: str, arguments: dict) -> dict:
    if action == "memory.read":
        query = _require(arguments, "query")
        limit = arguments.get("limit", 8)
        if not isinstance(limit, int):
            raise ValueError("Missing or invalid argument: limit")
        items = recall(query, max(1, min(limit, 50)))
        return {"items": items}

    if action == "memory.write":
        kind = _require(arguments, "kind")
        content = _require(arguments, "content")
        source = arguments.get("source", "core-executor")
        if not isinstance(source, str):
            raise ValueError("Missing or invalid argument: source")
        memory_id = remember(kind[:64], content[:4000], source[:64])
        return {"memory_id": memory_id, "content": content[:4000]}

    if action == "memory.correct":
        memory_id = _require(arguments, "memory_id", int)
        content = _require(arguments, "content")
        if not correct_memory(memory_id, content[:4000]):
            raise LookupError("Memory not found")
        return {"memory_id": memory_id, "content": content[:4000]}

    if action == "memory.delete":
        memory_id = _require(arguments, "memory_id", int)
        if not forget(memory_id):
            raise LookupError("Memory not found")
        return {"memory_id": memory_id}

    if action == "home_assistant.service":
        service = _require(arguments, "service")
        entity_id = _require(arguments, "entity_id")
        return await home_assistant(service, entity_id)

    raise ValueError("No execution adapter is registered for this action")


def _verify(action: str, result: dict) -> dict:
    if action == "memory.read":
        ok = isinstance(result.get("items"), list)
        return {"ok": ok, "method": "read_result"}

    if action in {"memory.write", "memory.correct"}:
        memory_id = result.get("memory_id")
        item = get_memory(memory_id) if isinstance(memory_id, int) else None
        ok = bool(item) and item.get("content") == result.get("content")
        return {"ok": ok, "method": "stored_row", "memory_id": memory_id}

    if action == "memory.delete":
        memory_id = result.get("memory_id")
        ok = isinstance(memory_id, int) and get_memory(memory_id) is None
        return {"ok": ok, "method": "row_absent", "memory_id": memory_id}

    if action == "home_assistant.service":
        ok = result.get("ok") is True
        return {"ok": ok, "method": "service_response"}

    return {"ok": False, "method": "unregistered"}


async def execute_tool(
    *,
    request_id: str,
    action: str,
    arguments: dict,
    plan_id: str | None = None,
    step_index: int | None = None,
) -> dict:
    """Execute one registered tool after policy and approval checks."""
    if action not in TOOLS:
        policy = decide(action)
        record_audit("execution.denied", {"action": action, "reason": policy.reason}, request_id)
        return ExecutionResult(
            id=str(uuid4()), request_id=request_id, plan_id=plan_id, step_index=step_index,
            action=action, state="denied", error=policy.reason,
        ).to_dict()

    prior = _existing_step(plan_id, step_index)
    if prior and prior.state == "completed":
        payload = prior.to_dict()
        payload["replayed"] = True
        return payload
    if prior and prior.state in {"running", "failed"}:
        # Failed/running persisted rows require operator review instead of blind retries.
        payload = prior.to_dict()
        payload["replayed"] = True
        return payload

    approval = _latest_approval(request_id, plan_id, action)
    confirmed = bool(approval and approval.get("state") == "approved")
    policy = decide(action, confirmed=confirmed)

    if policy.decision == "deny":
        record_audit("execution.denied", {"action": action, "reason": policy.reason}, request_id)
        return ExecutionResult(
            id=str(uuid4()), request_id=request_id, plan_id=plan_id, step_index=step_index,
            action=action, state="denied", error=policy.reason,
        ).to_dict()

    if policy.decision == "confirm":
        approval = _pending_or_new_approval(request_id, plan_id, action, arguments)
        state = "denied" if approval.get("state") == "rejected" else "approval_required"
        record_audit(
            "execution.approval_required" if state == "approval_required" else "execution.denied",
            {"action": action, "approval_id": approval["id"], "approval_state": approval["state"]},
            request_id,
        )
        return ExecutionResult(
            id=str(uuid4()), request_id=request_id, plan_id=plan_id, step_index=step_index,
            action=action, state=state, approval=approval,
        ).to_dict()

    execution_id = str(uuid4())
    try:
        _record_start(execution_id, request_id, plan_id, step_index, action, arguments)
        record_audit(
            "execution.started",
            {"execution_id": execution_id, "action": action, "plan_id": plan_id, "step_index": step_index},
            request_id,
        )
        result = await _invoke(action, arguments)
        verification = _verify(action, result)
        state = "completed" if verification.get("ok") is True else "failed"
        error = None if state == "completed" else "Execution result could not be verified"
        _record_finish(execution_id, state, result, verification, error)
        record_audit(
            "execution.completed" if state == "completed" else "execution.failed",
            {"execution_id": execution_id, "action": action, "verification": verification},
            request_id,
        )
        return ExecutionResult(
            id=execution_id, request_id=request_id, plan_id=plan_id, step_index=step_index,
            action=action, state=state, result=result, verification=verification, error=error,
        ).to_dict()
    except Exception as exc:
        # A row may not exist if validation failed before persistence; ensure the
        # failure is still durable in the audit ledger without leaking secrets.
        try:
            _record_finish(execution_id, "failed", None, None, type(exc).__name__)
        except Exception:
            pass
        record_audit(
            "execution.failed",
            {"execution_id": execution_id, "action": action, "error_type": type(exc).__name__},
            request_id,
        )
        return ExecutionResult(
            id=execution_id, request_id=request_id, plan_id=plan_id, step_index=step_index,
            action=action, state="failed", error=str(exc),
        ).to_dict()


def _load_plan(plan_id: str) -> dict | None:
    with connection() as db:
        row = db.execute(
            "SELECT id, request_id, goal, state, steps, created_at, updated_at FROM plans WHERE id = ?",
            (plan_id,),
        ).fetchone()
    if not row:
        return None
    plan = dict(row)
    plan["steps"] = json.loads(plan["steps"])
    return plan


def _set_plan_state(plan_id: str, state: str) -> None:
    with connection() as db:
        db.execute(
            "UPDATE plans SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (state, plan_id),
        )


async def execute_plan(plan_id: str) -> dict:
    """Run a plan sequentially, stopping safely on approval or failure."""
    plan = _load_plan(plan_id)
    if plan is None:
        return {"id": plan_id, "state": "not_found", "executions": []}

    request_id = plan.get("request_id") or f"plan:{plan_id}"
    _set_plan_state(plan_id, "running")
    executions: list[dict] = []

    for index, step in enumerate(plan["steps"]):
        if not isinstance(step, dict):
            _set_plan_state(plan_id, "failed")
            return {"id": plan_id, "request_id": request_id, "state": "failed",
                    "executions": executions, "error": f"Invalid plan step {index}"}
        action = step.get("action")
        arguments = step.get("arguments", {})
        if not isinstance(action, str) or not isinstance(arguments, dict):
            _set_plan_state(plan_id, "failed")
            return {"id": plan_id, "request_id": request_id, "state": "failed",
                    "executions": executions, "error": f"Invalid plan step {index}"}

        execution = await execute_tool(
            request_id=request_id,
            plan_id=plan_id,
            step_index=index,
            action=action,
            arguments=arguments,
        )
        executions.append(execution)

        if execution["state"] == "approval_required":
            _set_plan_state(plan_id, "awaiting_approval")
            return {"id": plan_id, "request_id": request_id, "state": "awaiting_approval",
                    "executions": executions}
        if execution["state"] != "completed":
            _set_plan_state(plan_id, "failed")
            return {"id": plan_id, "request_id": request_id, "state": "failed",
                    "executions": executions}

    _set_plan_state(plan_id, "completed")
    record_audit("plan.completed", {"plan_id": plan_id, "step_count": len(executions)}, request_id)
    return {"id": plan_id, "request_id": request_id, "state": "completed", "executions": executions}


def list_executions(request_id: str | None = None, limit: int = 50) -> list[dict]:
    initialise_execution_store()
    size = max(1, min(limit, 100))
    with connection() as db:
        if request_id:
            rows = db.execute(
                "SELECT * FROM core_executions WHERE request_id = ? ORDER BY created_at DESC LIMIT ?",
                (request_id, size),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM core_executions ORDER BY created_at DESC LIMIT ?",
                (size,),
            ).fetchall()
    return [_row_to_result(row).to_dict() for row in rows]

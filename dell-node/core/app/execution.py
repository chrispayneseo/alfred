"""Policy-gated tool execution and verification for Alfred Core."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from .core import TOOLS, decide
from .db import connection, create_approval, record_audit
from .integration_adapters import invoke as invoke_integration, verify as verify_integration
from .integrations import action_available
from . import memory_service


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


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _scope_hash(action: str, arguments: dict, plan_id: str | None, step_index: int | None) -> str:
    payload = {
        "action": action,
        "arguments": arguments,
        "plan_id": plan_id,
        "step_index": step_index,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _approval_summary(action: str, arguments: dict) -> str:
    """Describe the action without duplicating arbitrary user content into approvals."""
    if action == "memory.write":
        kind = arguments.get("kind", "memory")
        return f"Save a new {kind} memory."
    if action == "memory.correct":
        return f"Correct memory {arguments.get('memory_id', 'unknown')}."
    if action == "memory.delete":
        return f"Delete memory {arguments.get('memory_id', 'unknown')}."
    if action == "memory.candidate.promote":
        candidate_id = arguments.get("candidate_id", "unknown")
        supersede = arguments.get("supersede_memory_id")
        if supersede is not None:
            return f"Promote memory candidate {candidate_id} and supersede memory {supersede}."
        return f"Promote memory candidate {candidate_id} to durable memory."
    if action == "tasks.create":
        kind = arguments.get("kind", "task")
        return f"Create a new {kind}."
    if action == "tasks.update":
        return f"Edit task or reminder {arguments.get('source_id', 'unknown')}."
    if action == "tasks.complete":
        state = "complete" if arguments.get("completed") is True else "open"
        return f"Mark task or reminder {arguments.get('source_id', 'unknown')} as {state}."
    if action == "tasks.delete":
        return f"Delete task or reminder {arguments.get('source_id', 'unknown')}."
    if action == "home_assistant.service":
        service = arguments.get("service", "unknown service")
        entity = arguments.get("entity_id", "unknown entity")
        return f"Run {service} on {entity}."
    return f"Execute {action}."


def _load_json(value: str | None) -> dict | None:
    return json.loads(value) if value else None


def _row_to_result(row) -> ExecutionResult:
    return ExecutionResult(
        id=row["id"], request_id=row["request_id"], plan_id=row["plan_id"],
        step_index=row["step_index"], action=row["action"], state=row["state"],
        result=_load_json(row["result"]), verification=_load_json(row["verification"]),
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


def _latest_approval(request_id: str, plan_id: str | None, action: str,
                     scope_hash: str) -> dict | None:
    with connection() as db:
        row = db.execute(
            """SELECT id, request_id, plan_id, action, summary, risk_level, state,
                      scope_hash, step_index, created_at, resolved_at
               FROM approvals
               WHERE request_id = ? AND plan_id IS ? AND action = ? AND scope_hash = ?
               ORDER BY created_at DESC LIMIT 1""",
            (request_id, plan_id, action, scope_hash),
        ).fetchone()
    return dict(row) if row else None


def _pending_or_new_approval(request_id: str, plan_id: str | None, step_index: int | None,
                             action: str, arguments: dict, scope_hash: str) -> dict:
    existing = _latest_approval(request_id, plan_id, action, scope_hash)
    if existing and existing["state"] in {"pending", "approved", "rejected"}:
        return existing
    policy = decide(action)
    return create_approval(
        request_id,
        plan_id,
        action,
        _approval_summary(action, arguments),
        policy.level,
        scope_hash=scope_hash,
        step_index=step_index,
    )


def _record_start(execution_id: str, request_id: str, plan_id: str | None,
                  step_index: int | None, action: str, arguments: dict) -> None:
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


async def _invoke(action: str, arguments: dict, request_id: str) -> dict:
    if action == "memory.read":
        query = _require(arguments, "query")
        limit = arguments.get("limit", 8)
        if not isinstance(limit, int):
            raise ValueError("Missing or invalid argument: limit")
        return {"items": memory_service.retrieve_context(query, limit)}

    if action == "memory.write":
        kind = _require(arguments, "kind")
        content = _require(arguments, "content")
        source = arguments.get("source", "core-executor")
        if not isinstance(source, str):
            raise ValueError("Missing or invalid argument: source")
        item = memory_service.create_memory(kind, content, source, request_id=request_id)
        return {"memory_id": item["id"], "content": item["content"]}

    if action == "memory.correct":
        memory_id = _require(arguments, "memory_id", int)
        content = _require(arguments, "content")
        item = memory_service.correct_memory(memory_id, content, request_id=request_id)
        if item is None:
            raise LookupError("Memory not found")
        return {"memory_id": item["id"], "content": item["content"]}

    if action == "memory.delete":
        memory_id = _require(arguments, "memory_id", int)
        if not memory_service.delete_memory(memory_id, request_id=request_id):
            raise LookupError("Memory not found")
        return {"memory_id": memory_id}

    if action == "memory.candidate.list":
        state = arguments.get("state")
        if state is not None and not isinstance(state, str):
            raise ValueError("Missing or invalid argument: state")
        limit = arguments.get("limit", 50)
        if not isinstance(limit, int):
            raise ValueError("Missing or invalid argument: limit")
        return {"items": memory_service.list_memory_candidates(state, limit)}

    if action == "memory.candidate.propose":
        content = _require(arguments, "content")
        memory_type = arguments.get("memory_type", "fact")
        source = arguments.get("source", "local-context")
        confidence = arguments.get("confidence", 0.8)
        conversation_id = arguments.get("conversation_id")
        if not isinstance(memory_type, str) or not isinstance(source, str):
            raise ValueError("Missing or invalid candidate metadata")
        if not isinstance(confidence, (int, float)):
            raise ValueError("Missing or invalid argument: confidence")
        if conversation_id is not None and not isinstance(conversation_id, str):
            raise ValueError("Missing or invalid argument: conversation_id")
        candidate = memory_service.propose_memory_candidate(
            content,
            memory_type=memory_type,
            source=source,
            source_request_id=request_id,
            source_conversation_id=conversation_id,
            confidence=float(confidence),
            request_id=request_id,
        )
        return {"candidate": candidate}

    if action == "memory.candidate.dismiss":
        candidate_id = _require(arguments, "candidate_id")
        candidate = memory_service.dismiss_memory_candidate(candidate_id, request_id=request_id)
        if candidate is None:
            raise LookupError("Memory candidate not found")
        return {"candidate": candidate}

    if action == "memory.candidate.promote":
        candidate_id = _require(arguments, "candidate_id")
        supersede_memory_id = arguments.get("supersede_memory_id")
        if supersede_memory_id is not None and not isinstance(supersede_memory_id, int):
            raise ValueError("Missing or invalid argument: supersede_memory_id")
        return memory_service.promote_memory_candidate(
            candidate_id,
            supersede_memory_id=supersede_memory_id,
            request_id=request_id,
        )

    integration_result = await invoke_integration(action, arguments, request_id)
    if integration_result is not None:
        return integration_result

    raise ValueError("No execution adapter is registered for this action")


def _verify(action: str, result: dict) -> dict:
    if action in {"memory.read", "memory.candidate.list"}:
        return {"ok": isinstance(result.get("items"), list), "method": "read_result"}

    if action in {"memory.write", "memory.correct"}:
        memory_id = result.get("memory_id")
        item = memory_service.get_memory(memory_id) if isinstance(memory_id, int) else None
        ok = bool(item) and item.get("content") == result.get("content")
        return {"ok": ok, "method": "stored_row", "memory_id": memory_id}

    if action == "memory.delete":
        memory_id = result.get("memory_id")
        ok = isinstance(memory_id, int) and memory_service.get_memory(memory_id) is None
        return {"ok": ok, "method": "row_absent", "memory_id": memory_id}

    if action == "memory.candidate.propose":
        candidate = result.get("candidate")
        candidate_id = candidate.get("id") if isinstance(candidate, dict) else None
        stored = memory_service.get_memory_candidate(candidate_id) if isinstance(candidate_id, str) else None
        ok = bool(stored) and stored.get("state") == candidate.get("state")
        return {"ok": ok, "method": "candidate_row", "candidate_id": candidate_id}

    if action == "memory.candidate.dismiss":
        candidate = result.get("candidate")
        candidate_id = candidate.get("id") if isinstance(candidate, dict) else None
        stored = memory_service.get_memory_candidate(candidate_id) if isinstance(candidate_id, str) else None
        ok = bool(stored) and stored.get("state") == "dismissed"
        return {"ok": ok, "method": "candidate_state", "candidate_id": candidate_id}

    if action == "memory.candidate.promote":
        candidate = result.get("candidate")
        memory = result.get("memory")
        candidate_id = candidate.get("id") if isinstance(candidate, dict) else None
        memory_id = memory.get("id") if isinstance(memory, dict) else None
        stored_candidate = memory_service.get_memory_candidate(candidate_id) if isinstance(candidate_id, str) else None
        stored_memory = memory_service.get_memory(memory_id) if isinstance(memory_id, int) else None
        ok = bool(stored_candidate) and stored_candidate.get("state") == "promoted" and bool(stored_memory)
        return {
            "ok": ok,
            "method": "promoted_memory",
            "candidate_id": candidate_id,
            "memory_id": memory_id,
            "superseded_memory_id": result.get("superseded_memory_id"),
        }

    integration_verification = verify_integration(action, result)
    if integration_verification is not None:
        return integration_verification

    return {"ok": False, "method": "unregistered"}


async def execute_tool(*, request_id: str, action: str, arguments: dict,
                       plan_id: str | None = None, step_index: int | None = None) -> dict:
    """Execute one registered tool after deterministic policy and exact-scope approval checks."""
    if action not in TOOLS:
        policy = decide(action)
        record_audit("execution.denied", {"action": action, "reason": policy.reason}, request_id)
        return ExecutionResult(
            id=str(uuid4()), request_id=request_id, plan_id=plan_id, step_index=step_index,
            action=action, state="denied", error=policy.reason,
        ).to_dict()

    available, unavailable_reason = action_available(action)
    if not available:
        record_audit(
            "execution.unavailable",
            {"action": action, "reason": unavailable_reason},
            request_id,
        )
        return ExecutionResult(
            id=str(uuid4()), request_id=request_id, plan_id=plan_id, step_index=step_index,
            action=action, state="denied", error=unavailable_reason,
        ).to_dict()

    prior = _existing_step(plan_id, step_index)
    if prior and prior.state in {"completed", "running", "failed"}:
        payload = prior.to_dict()
        payload["replayed"] = True
        return payload

    scope_hash = _scope_hash(action, arguments, plan_id, step_index)
    approval = _latest_approval(request_id, plan_id, action, scope_hash)
    confirmed = bool(approval and approval.get("state") == "approved")
    policy = decide(action, confirmed=confirmed)

    if policy.decision == "deny":
        record_audit("execution.denied", {"action": action, "reason": policy.reason}, request_id)
        return ExecutionResult(
            id=str(uuid4()), request_id=request_id, plan_id=plan_id, step_index=step_index,
            action=action, state="denied", error=policy.reason,
        ).to_dict()

    if policy.decision == "confirm":
        approval = _pending_or_new_approval(
            request_id, plan_id, step_index, action, arguments, scope_hash
        )
        state = "denied" if approval.get("state") == "rejected" else "approval_required"
        record_audit(
            "execution.approval_required" if state == "approval_required" else "execution.denied",
            {
                "action": action,
                "approval_id": approval["id"],
                "approval_state": approval["state"],
                "scope_hash": scope_hash,
                "step_index": step_index,
            },
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
            {
                "execution_id": execution_id,
                "action": action,
                "plan_id": plan_id,
                "step_index": step_index,
                "scope_hash": scope_hash,
            },
            request_id,
        )
        result = await _invoke(action, arguments, request_id)
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
            request_id=request_id, plan_id=plan_id, step_index=index,
            action=action, arguments=arguments,
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

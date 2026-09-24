"""Fail-closed recovery policy for Alfred Core executions.

Interrupted or failed read-only work can be retried deliberately. Mutating or
external actions are never replayed automatically because the side effect may
have happened even when Alfred did not receive a successful response.
"""

from __future__ import annotations

import json
from uuid import uuid4

from .core import TOOLS
from .db import connection, record_audit
from . import execution


RETRYABLE_STATES = {"failed", "interrupted"}


def initialise_recovery_store() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS core_recovery_attempts (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          action TEXT NOT NULL,
          state TEXT NOT NULL,
          error_type TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS core_recovery_execution ON core_recovery_attempts(execution_id, created_at DESC)")


def recover_interrupted_work() -> dict:
    """Mark work left running by a previous Core process as interrupted."""
    initialise_recovery_store()
    with connection() as db:
        executions = db.execute(
            "SELECT id, request_id, action FROM core_executions WHERE state = 'running'"
        ).fetchall()
        plans = db.execute(
            "SELECT id, request_id FROM plans WHERE state = 'running'"
        ).fetchall()
        db.execute("""UPDATE core_executions
          SET state = 'interrupted', error = 'Core process interrupted', completed_at = CURRENT_TIMESTAMP
          WHERE state = 'running'""")
        db.execute("""UPDATE plans SET state = 'interrupted', updated_at = CURRENT_TIMESTAMP
          WHERE state = 'running'""")

    for row in executions:
        record_audit(
            "execution.interrupted",
            {"execution_id": row["id"], "action": row["action"]},
            row["request_id"],
        )
    for row in plans:
        record_audit("plan.interrupted", {"plan_id": row["id"]}, row["request_id"])
    return {"executions": len(executions), "plans": len(plans)}


def _policy_for(action: str, state: str) -> str:
    tool = TOOLS.get(action)
    if state not in RETRYABLE_STATES:
        return "not_retryable"
    if tool and tool.get("risk") == "read":
        return "retryable"
    return "reconcile_required"


def get_recovery_item(execution_id: str) -> dict | None:
    initialise_recovery_store()
    with connection() as db:
        row = db.execute(
            """SELECT id, request_id, plan_id, step_index, action, state, error,
                      created_at, completed_at
               FROM core_executions WHERE id = ?""",
            (execution_id,),
        ).fetchone()
    if not row:
        return None
    item = dict(row)
    item["recovery"] = _policy_for(item["action"], item["state"])
    return item


def recovery_summary(limit: int = 50) -> dict:
    initialise_recovery_store()
    size = max(1, min(limit, 100))
    with connection() as db:
        rows = db.execute(
            """SELECT id, request_id, plan_id, step_index, action, state, error,
                      created_at, completed_at
               FROM core_executions
               WHERE state IN ('failed', 'interrupted')
               ORDER BY created_at DESC LIMIT ?""",
            (size,),
        ).fetchall()
    items = []
    counts = {"retryable": 0, "reconcile_required": 0}
    for row in rows:
        item = dict(row)
        policy = _policy_for(item["action"], item["state"])
        item["recovery"] = policy
        if policy in counts:
            counts[policy] += 1
        items.append(item)
    return {"counts": counts, "items": items}


def _record_attempt_start(execution_id: str, action: str) -> str:
    attempt_id = str(uuid4())
    with connection() as db:
        db.execute(
            """INSERT INTO core_recovery_attempts (id, execution_id, action, state)
               VALUES (?, ?, ?, 'running')""",
            (attempt_id, execution_id, action),
        )
    return attempt_id


def _record_attempt_finish(attempt_id: str, state: str, error_type: str | None = None) -> None:
    with connection() as db:
        db.execute(
            """UPDATE core_recovery_attempts
               SET state = ?, error_type = ?, completed_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (state, error_type, attempt_id),
        )


async def retry_execution(execution_id: str) -> dict:
    """Retry the same durable execution row only when the action is read-only."""
    initialise_recovery_store()
    with connection() as db:
        row = db.execute("SELECT * FROM core_executions WHERE id = ?", (execution_id,)).fetchone()
    if not row:
        return {"id": execution_id, "state": "not_found"}

    item = dict(row)
    recovery = _policy_for(item["action"], item["state"])
    if recovery == "reconcile_required":
        record_audit(
            "execution.retry_denied",
            {"execution_id": execution_id, "action": item["action"], "reason": recovery},
            item["request_id"],
        )
        return {
            "id": execution_id,
            "state": item["state"],
            "recovery": recovery,
            "error": "This action may have produced a side effect and cannot be safely replayed.",
        }
    if recovery != "retryable":
        return {"id": execution_id, "state": item["state"], "recovery": recovery}

    arguments = json.loads(item["arguments"])
    attempt_id = _record_attempt_start(execution_id, item["action"])
    with connection() as db:
        db.execute(
            """UPDATE core_executions
               SET state = 'running', result = NULL, verification = NULL,
                   error = NULL, completed_at = NULL
               WHERE id = ? AND state IN ('failed', 'interrupted')""",
            (execution_id,),
        )

    record_audit(
        "execution.retry_started",
        {"execution_id": execution_id, "attempt_id": attempt_id, "action": item["action"]},
        item["request_id"],
    )
    try:
        result = await execution._invoke(item["action"], arguments, item["request_id"])
        verification = execution._verify(item["action"], result)
        state = "completed" if verification.get("ok") is True else "failed"
        error = None if state == "completed" else "Retry result could not be verified"
        execution._record_finish(execution_id, state, result, verification, error)
        _record_attempt_finish(attempt_id, state)
        record_audit(
            "execution.retry_completed" if state == "completed" else "execution.retry_failed",
            {"execution_id": execution_id, "attempt_id": attempt_id, "verification": verification},
            item["request_id"],
        )
        refreshed = get_recovery_item(execution_id) or {"id": execution_id, "state": state}
        refreshed["result"] = result
        refreshed["verification"] = verification
        refreshed["attempt_id"] = attempt_id
        return refreshed
    except Exception as exc:
        execution._record_finish(execution_id, "failed", None, None, type(exc).__name__)
        _record_attempt_finish(attempt_id, "failed", type(exc).__name__)
        record_audit(
            "execution.retry_failed",
            {"execution_id": execution_id, "attempt_id": attempt_id, "error_type": type(exc).__name__},
            item["request_id"],
        )
        return {
            "id": execution_id,
            "state": "failed",
            "recovery": "retryable",
            "attempt_id": attempt_id,
            "error_type": type(exc).__name__,
        }

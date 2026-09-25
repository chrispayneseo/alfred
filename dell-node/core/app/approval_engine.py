"""Goal-aware, content-minimised approval context for Alfred Phase 5D.

The engine enriches approvals created by the existing policy-gated executor.
It never changes a policy decision, approval scope hash, tool arguments or
execution path. Context contains identifiers, counts and deterministic generic
risk/effect descriptions only; connected-source content and resolved argument
values are never copied into this store.
"""

from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, HTTPException

from .db import connection, record_audit
from .integrations import action_owner


APPROVAL_ENGINE_MODE = "goal_aware_exact_scope_v1"
router = APIRouter(tags=["core-approval-engine"])

_RISK_EXPLANATIONS = {
    "safe_write": "Changes durable local Alfred data and requires owner approval.",
    "reversible": "Changes a reversible device or service state and requires owner approval.",
    "external": "Changes data in a connected external service and requires owner approval.",
    "high_impact": "High-impact actions are not automatically authorised by the goal engine.",
}


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS agent_approval_context (
            approval_id TEXT PRIMARY KEY,
            goal_id TEXT NOT NULL,
            goal_step_id TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            step_position INTEGER NOT NULL,
            step_count INTEGER NOT NULL,
            action TEXT NOT NULL,
            integration TEXT,
            risk_level TEXT NOT NULL,
            effect TEXT NOT NULL,
            dependency_count INTEGER NOT NULL DEFAULT 0,
            verified_dependency_count INTEGER NOT NULL DEFAULT 0,
            binding_count INTEGER NOT NULL DEFAULT 0,
            scope_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute(
            "CREATE INDEX IF NOT EXISTS agent_approval_context_goal "
            "ON agent_approval_context(goal_id, step_position)"
        )


def _effect_for(action: str) -> str:
    if action == "memory.write":
        return "create_local_memory"
    if action == "memory.correct":
        return "update_local_memory"
    if action == "memory.delete":
        return "delete_local_memory"
    if action == "memory.candidate.promote":
        return "promote_local_memory"
    if action == "tasks.create":
        return "create_local_task"
    if action in {"tasks.update", "tasks.complete"}:
        return "update_local_task"
    if action == "tasks.delete":
        return "delete_local_task"
    if action == "home_assistant.service":
        return "change_device_state"
    if action == "calendar.events.create":
        return "create_external_calendar_event"
    if action == "calendar.events.update":
        return "update_external_calendar_event"
    if action == "calendar.events.delete":
        return "delete_external_calendar_event"
    if action == "email.draft.create":
        return "create_external_email_draft"
    return "registered_tool_change"


def _goal_step(plan_id: str, step_index: int) -> tuple[dict, dict] | None:
    initialise()
    with connection() as db:
        goal = db.execute(
            "SELECT id, request_id, plan_id FROM agent_goals WHERE plan_id = ?",
            (plan_id,),
        ).fetchone()
        if goal is None:
            return None
        step = db.execute(
            """SELECT id, position, action, depends_on
               FROM agent_goal_steps WHERE goal_id = ? AND position = ?""",
            (goal["id"], step_index),
        ).fetchone()
        if step is None:
            return None
        step_count = int(db.execute(
            "SELECT COUNT(*) FROM agent_goal_steps WHERE goal_id = ?", (goal["id"],)
        ).fetchone()[0])
    goal_item = dict(goal)
    goal_item["step_count"] = step_count
    return goal_item, dict(step)


def _dependency_counts(plan_id: str, depends_on_json: str) -> tuple[int, int]:
    import json

    try:
        dependency_ids = json.loads(depends_on_json or "[]")
    except json.JSONDecodeError:
        dependency_ids = []
    if not isinstance(dependency_ids, list):
        dependency_ids = []
    dependency_count = len(dependency_ids)
    if not dependency_ids:
        return 0, 0

    placeholders = ",".join("?" for _ in dependency_ids)
    with connection() as db:
        rows = db.execute(
            f"""SELECT s.id, e.state, e.verification
                FROM agent_goal_steps s
                LEFT JOIN core_executions e
                  ON e.plan_id = ? AND e.step_index = s.position
                WHERE s.id IN ({placeholders})""",
            (plan_id, *dependency_ids),
        ).fetchall()

    verified = 0
    for row in rows:
        if str(row["state"] or "") != "completed":
            continue
        try:
            payload = json.loads(row["verification"] or "null")
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict) and payload.get("ok") is True:
            verified += 1
    return dependency_count, verified


def _binding_count(goal_id: str, step_position: int) -> int:
    with connection() as db:
        if db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_workflows'"
        ).fetchone() is None:
            return 0
        row = db.execute(
            """SELECT COUNT(*)
               FROM agent_workflow_bindings b
               JOIN agent_workflows w ON w.id = b.workflow_id
               WHERE w.goal_id = ? AND b.step_position = ?""",
            (goal_id, step_position),
        ).fetchone()
    return int(row[0]) if row else 0


def record_context(*, approval: dict, request_id: str, plan_id: str | None,
                   step_index: int | None, action: str) -> dict | None:
    """Attach generic goal context to an exact executor approval, if applicable."""
    if plan_id is None or step_index is None:
        return None
    approval_id = approval.get("id")
    scope_hash = approval.get("scope_hash")
    risk_level = approval.get("risk_level")
    if not all(isinstance(value, str) and value for value in (approval_id, scope_hash, risk_level)):
        return None

    linked = _goal_step(plan_id, step_index)
    if linked is None:
        return None
    goal, step = linked
    if str(step["action"]) != action:
        return None

    dependency_count, verified_dependency_count = _dependency_counts(
        plan_id, str(step.get("depends_on") or "[]")
    )
    binding_count = _binding_count(str(goal["id"]), step_index)
    integration = action_owner(action)
    effect = _effect_for(action)

    with connection() as db:
        db.execute(
            """INSERT INTO agent_approval_context
               (approval_id, goal_id, goal_step_id, plan_id, step_position, step_count,
                action, integration, risk_level, effect, dependency_count,
                verified_dependency_count, binding_count, scope_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(approval_id) DO UPDATE SET
                 risk_level = excluded.risk_level,
                 effect = excluded.effect,
                 dependency_count = excluded.dependency_count,
                 verified_dependency_count = excluded.verified_dependency_count,
                 binding_count = excluded.binding_count,
                 updated_at = CURRENT_TIMESTAMP""",
            (
                approval_id, goal["id"], step["id"], plan_id, step_index,
                goal["step_count"], action, integration, risk_level, effect,
                dependency_count, verified_dependency_count, binding_count, scope_hash,
            ),
        )

    record_audit(
        "approval.goal_context_recorded",
        {
            "approval_id": approval_id,
            "goal_id": goal["id"],
            "step_position": step_index,
            "risk_level": risk_level,
            "effect": effect,
            "dependency_count": dependency_count,
            "verified_dependency_count": verified_dependency_count,
            "binding_count": binding_count,
            "content_recorded": False,
        },
        request_id,
    )
    return get_context(str(approval_id))


def _rationale(item: dict) -> str:
    dependencies = int(item.get("dependency_count") or 0)
    verified = int(item.get("verified_dependency_count") or 0)
    bindings = int(item.get("binding_count") or 0)
    if bindings:
        return (
            f"This goal step follows {verified} verified prerequisite step(s) and uses "
            f"{bindings} verified scalar hand-off(s)."
        )
    if dependencies:
        return f"This goal step follows {verified} verified prerequisite step(s)."
    return "This is the next approval-gated change in the durable goal."


def get_context(approval_id: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute(
            """SELECT approval_id, goal_id, goal_step_id, plan_id, step_position,
                      step_count, action, integration, risk_level, effect,
                      dependency_count, verified_dependency_count, binding_count,
                      scope_hash, created_at, updated_at
               FROM agent_approval_context WHERE approval_id = ?""",
            (approval_id,),
        ).fetchone()
        approval = db.execute(
            "SELECT state FROM approvals WHERE id = ?", (approval_id,)
        ).fetchone()
    if row is None:
        return None
    item = dict(row)
    item["approval_state"] = str(approval["state"]) if approval else "unknown"
    item["why"] = _rationale(item)
    item["risk_explanation"] = _RISK_EXPLANATIONS.get(
        str(item["risk_level"]), "This registered change requires deterministic Core policy."
    )
    item["content_policy"] = "metadata_only"
    item["raw_arguments_stored"] = False
    item["bound_values_stored"] = False
    return item


def pending_context(limit: int = 50) -> list[dict]:
    initialise()
    size = max(1, min(int(limit), 100))
    with connection() as db:
        rows = db.execute(
            """SELECT c.approval_id
               FROM agent_approval_context c
               JOIN approvals a ON a.id = c.approval_id
               WHERE a.state = 'pending'
               ORDER BY a.created_at DESC LIMIT ?""",
            (size,),
        ).fetchall()
    return [item for row in rows if (item := get_context(str(row["approval_id"]))) is not None]


def status() -> dict:
    initialise()
    with connection() as db:
        rows = db.execute(
            "SELECT risk_level, COUNT(*) AS count FROM agent_approval_context GROUP BY risk_level"
        ).fetchall()
        pending = int(db.execute(
            """SELECT COUNT(*) FROM agent_approval_context c
               JOIN approvals a ON a.id = c.approval_id WHERE a.state = 'pending'"""
        ).fetchone()[0])
    counts = Counter({str(row["risk_level"]): int(row["count"]) for row in rows})
    return {
        "mode": APPROVAL_ENGINE_MODE,
        "contexts": sum(counts.values()),
        "pending": pending,
        "risk_counts": dict(counts),
        "risk_source": "core_tools_deterministic",
        "approval_scope": "existing_sha256_exact_arguments",
        "goal_context": "metadata_only",
        "raw_arguments_stored": False,
        "bound_values_stored": False,
        "policy_changes": False,
        "cloud_models": False,
    }


def install_hook() -> None:
    """Wrap approval creation only; do not replace policy, hashing or execution."""
    from . import execution

    if getattr(execution._pending_or_new_approval, "_phase5d_wrapped", False):
        return
    original = execution._pending_or_new_approval

    def pending_or_new_with_context(request_id: str, plan_id: str | None,
                                    step_index: int | None, action: str,
                                    arguments: dict, scope_hash: str) -> dict:
        approval = original(request_id, plan_id, step_index, action, arguments, scope_hash)
        # The context engine receives no arguments; exact values remain solely in
        # the executor/proposal boundary established by earlier phases.
        try:
            record_context(
                approval=approval,
                request_id=request_id,
                plan_id=plan_id,
                step_index=step_index,
                action=action,
            )
        except Exception as exc:
            record_audit(
                "approval.goal_context_failed",
                {"action": action, "error_type": type(exc).__name__},
                request_id,
            )
        return approval

    pending_or_new_with_context._phase5d_wrapped = True
    execution._pending_or_new_approval = pending_or_new_with_context


@router.get("/v1/core/approval-engine/status")
async def approval_engine_status():
    return status()


@router.get("/v1/core/approval-engine/pending")
async def approval_engine_pending(limit: int = 50):
    return {"items": pending_context(limit)}


@router.get("/v1/core/approvals/{approval_id}/context")
async def approval_context_route(approval_id: str):
    item = get_context(approval_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Goal-aware approval context not found")
    return item

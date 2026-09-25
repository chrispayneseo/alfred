"""Phase 5A bindings into Alfred's existing executor and restart recovery.

The wrappers preserve the existing policy/approval/verification implementation.
They only add goal cancellation protection and goal-state reconciliation.
"""

from __future__ import annotations

from .db import connection


_INSTALLED = False


def install() -> None:
    global _INSTALLED
    if _INSTALLED:
        return

    from . import execution, goals, recovery

    original_execute_plan = execution.execute_plan
    original_recover = recovery.recover_interrupted_work

    async def execute_plan_with_goal_guard(plan_id: str) -> dict:
        goals.initialise()
        with connection() as db:
            plan = db.execute("SELECT state FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if plan is not None and str(plan["state"]) == "cancelled":
            return {"id": plan_id, "state": "cancelled", "executions": []}

        result = await original_execute_plan(plan_id)
        with connection() as db:
            row = db.execute("SELECT id FROM agent_goals WHERE plan_id = ?", (plan_id,)).fetchone()
        if row is not None:
            goals.sync_goal_progress(str(row["id"]))
        return result

    def recover_with_goals() -> dict:
        # Keep the established Phase 3 return contract byte-for-byte compatible;
        # goal reconciliation is durable local follow-up state, not a new recovery
        # response field.
        result = original_recover()
        goals.recover_after_restart()
        return result

    execution.execute_plan = execute_plan_with_goal_guard
    recovery.recover_interrupted_work = recover_with_goals
    _INSTALLED = True

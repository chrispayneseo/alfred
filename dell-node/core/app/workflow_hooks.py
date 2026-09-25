"""Phase 5C binding hook for Alfred's existing policy-gated executor."""

from __future__ import annotations

from .db import connection, record_audit


_INSTALLED = False


def install() -> None:
    global _INSTALLED
    if _INSTALLED:
        return

    from . import execution, goals, workflows

    original_execute_tool = execution.execute_tool

    async def execute_tool_with_workflow_bindings(*, request_id: str, action: str, arguments: dict,
                                                  plan_id: str | None = None,
                                                  step_index: int | None = None) -> dict:
        if plan_id is None or step_index is None:
            return await original_execute_tool(
                request_id=request_id, action=action, arguments=arguments,
                plan_id=plan_id, step_index=step_index,
            )

        workflows.initialise()
        with connection() as db:
            row = db.execute(
                """SELECT w.goal_id
                   FROM agent_workflows w
                   JOIN agent_workflow_bindings b ON b.workflow_id = w.id
                   WHERE w.plan_id = ? AND b.step_position = ?
                   LIMIT 1""",
                (plan_id, step_index),
            ).fetchone()

        if row is None:
            return await original_execute_tool(
                request_id=request_id, action=action, arguments=arguments,
                plan_id=plan_id, step_index=step_index,
            )

        goal = goals.get_goal(str(row["goal_id"]))
        step = None if goal is None else next(
            (candidate for candidate in goal.get("steps", []) if int(candidate["position"]) == step_index),
            None,
        )
        if goal is None or step is None or str(step.get("action")) != action:
            record_audit(
                "workflow.binding_failed",
                {"plan_id": plan_id, "step_index": step_index, "reason": "plan_mismatch"},
                request_id,
            )
            return {
                "id": "workflow-binding-failed",
                "request_id": request_id,
                "plan_id": plan_id,
                "step_index": step_index,
                "action": action,
                "state": "failed",
                "result": None,
                "verification": None,
                "approval": None,
                "error": "Workflow binding could not be resolved safely",
                "workflow": {"bindings_applied": 0, "resolved_before_policy": True},
            }

        try:
            resolved, binding_count = workflows.resolve_step_arguments(goal, step)
        except workflows.WorkflowBindingError as exc:
            record_audit(
                "workflow.binding_failed",
                {
                    "goal_id": goal["id"],
                    "plan_id": plan_id,
                    "step_index": step_index,
                    "reason": type(exc).__name__,
                },
                request_id,
            )
            return {
                "id": "workflow-binding-failed",
                "request_id": request_id,
                "plan_id": plan_id,
                "step_index": step_index,
                "action": action,
                "state": "failed",
                "result": None,
                "verification": None,
                "approval": None,
                "error": "Workflow binding could not be resolved safely",
                "workflow": {"bindings_applied": 0, "resolved_before_policy": True},
            }

        result = await original_execute_tool(
            request_id=request_id,
            action=action,
            arguments=resolved,
            plan_id=plan_id,
            step_index=step_index,
        )
        result = dict(result)
        result["workflow"] = {
            "bindings_applied": binding_count,
            "resolved_before_policy": True,
            "values_exposed": False,
        }
        return result

    execution.execute_tool = execute_tool_with_workflow_bindings
    _INSTALLED = True

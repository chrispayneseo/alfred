"""Bounded owner-started execution loop for Alfred Phase 5B.

A durable goal never starts itself. Once the owner explicitly starts a run, this
module may continue through already-planned steps using Alfred's existing
policy-gated executor. Read-only steps can complete automatically; mutations
stop at the exact-scope approval boundary. Resolving that approval can resume
the same goal without replaying completed work.

The loop never calls a language model, changes tool policy, resolves approvals
itself, or invents new plan steps.
"""

from __future__ import annotations

import sqlite3
from collections import Counter
from uuid import uuid4

from fastapi import APIRouter, HTTPException

from .core import TOOLS
from .db import connection, record_audit
from . import execution, goals


LOOP_MODE = "bounded_agent_loop_v1"
MAX_STEPS_PER_RUN = 20
RUN_STATES = {"running", "completed", "awaiting_approval", "blocked", "cancelled", "interrupted"}
router = APIRouter(tags=["core-agent-loop"])
_HOOKS_INSTALLED = False


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS agent_goal_runs (
            id TEXT PRIMARY KEY,
            goal_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            trigger TEXT NOT NULL,
            state TEXT NOT NULL,
            stop_reason TEXT,
            steps_attempted INTEGER NOT NULL DEFAULT 0,
            last_step_id TEXT,
            started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT
        )""")
        db.execute(
            "CREATE INDEX IF NOT EXISTS agent_goal_runs_goal "
            "ON agent_goal_runs(goal_id, started_at DESC)"
        )
        db.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS agent_goal_runs_one_running
               ON agent_goal_runs(goal_id) WHERE state = 'running'"""
        )


def _set_plan_state(plan_id: str, state: str) -> None:
    with connection() as db:
        db.execute(
            "UPDATE plans SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (state, plan_id),
        )


def _begin_run(goal: dict, trigger: str) -> tuple[str | None, dict | None]:
    initialise()
    run_id = str(uuid4())
    try:
        with connection() as db:
            db.execute(
                """INSERT INTO agent_goal_runs
                   (id, goal_id, request_id, trigger, state)
                   VALUES (?, ?, ?, ?, 'running')""",
                (run_id, goal["id"], goal["request_id"], trigger),
            )
    except sqlite3.IntegrityError:
        with connection() as db:
            row = db.execute(
                """SELECT id, state, steps_attempted, last_step_id, started_at
                   FROM agent_goal_runs
                   WHERE goal_id = ? AND state = 'running'
                   ORDER BY started_at DESC LIMIT 1""",
                (goal["id"],),
            ).fetchone()
        existing = dict(row) if row else {"state": "running"}
        return None, existing
    return run_id, None


def _finish_run(run_id: str, state: str, *, reason: str | None,
                steps_attempted: int, last_step_id: str | None) -> None:
    if state not in RUN_STATES - {"running"}:
        raise ValueError("Invalid agent run terminal state")
    with connection() as db:
        db.execute(
            """UPDATE agent_goal_runs
               SET state = ?, stop_reason = ?, steps_attempted = ?, last_step_id = ?,
                   completed_at = CURRENT_TIMESTAMP
               WHERE id = ? AND state = 'running'""",
            (state, reason, steps_attempted, last_step_id, run_id),
        )


def _safe_execution_summary(result: dict, step: dict) -> dict:
    approval = result.get("approval") if isinstance(result.get("approval"), dict) else None
    summary = {
        "step_id": step["id"],
        "position": int(step["position"]),
        "action": step["action"],
        "state": result.get("state"),
        "verified": (result.get("verification") or {}).get("ok") is True,
        "replayed": bool(result.get("replayed")),
    }
    if approval:
        summary["approval"] = {
            "id": approval.get("id"),
            "state": approval.get("state"),
            "risk_level": approval.get("risk_level"),
            "summary": approval.get("summary"),
        }
    return summary


def _run_response(*, run_id: str | None, goal: dict, state: str, reason: str,
                  attempts: list[dict] | None = None, existing_run: dict | None = None) -> dict:
    payload = {
        "run_id": run_id,
        "goal_id": goal["id"],
        "plan_id": goal["plan_id"],
        "state": state,
        "stop_reason": reason,
        "current_step_id": goal.get("current_step_id"),
        "steps": attempts or [],
        "automatic_start": False,
        "automatic_safe_continuation": True,
        "approval_policy": "existing_exact_scope",
    }
    if existing_run is not None:
        payload["existing_run"] = existing_run
    return payload


async def run_goal(goal_id: str, *, trigger: str = "owner") -> dict:
    """Continue one existing durable goal until completion, approval or failure.

    The loop is finite because Phase 5A limits goals to 20 ordered steps and this
    function never adds/reorders steps. Every action still passes through the
    existing executor, policy, availability, approval and verification layers.
    """
    initialise()
    goal = goals.get_goal(goal_id)
    if goal is None:
        return {"goal_id": goal_id, "state": "not_found"}

    if goal["state"] == "completed":
        return _run_response(run_id=None, goal=goal, state="completed", reason="already_completed")
    if goal["state"] == "cancelled":
        return _run_response(run_id=None, goal=goal, state="cancelled", reason="goal_cancelled")
    if goal["state"] == "blocked":
        return _run_response(run_id=None, goal=goal, state="blocked", reason="recovery_or_failure_requires_attention")

    run_id, existing = _begin_run(goal, trigger)
    if run_id is None:
        return _run_response(
            run_id=None, goal=goal, state="running", reason="already_running",
            existing_run=existing,
        )

    record_audit(
        "goal.run_started",
        {"goal_id": goal_id, "run_id": run_id, "trigger": trigger, "bounded": True},
        goal["request_id"],
    )
    attempts: list[dict] = []
    last_step_id: str | None = None

    try:
        for _ in range(MAX_STEPS_PER_RUN):
            goal = goals.sync_goal_progress(goal_id) or goal
            if goal["state"] == "completed":
                _set_plan_state(goal["plan_id"], "completed")
                _finish_run(
                    run_id, "completed", reason="goal_completed",
                    steps_attempted=len(attempts), last_step_id=last_step_id,
                )
                record_audit(
                    "goal.run_completed",
                    {"goal_id": goal_id, "run_id": run_id, "steps_attempted": len(attempts)},
                    goal["request_id"],
                )
                return _run_response(
                    run_id=run_id, goal=goal, state="completed", reason="goal_completed",
                    attempts=attempts,
                )
            if goal["state"] == "cancelled":
                _finish_run(
                    run_id, "cancelled", reason="goal_cancelled",
                    steps_attempted=len(attempts), last_step_id=last_step_id,
                )
                return _run_response(
                    run_id=run_id, goal=goal, state="cancelled", reason="goal_cancelled",
                    attempts=attempts,
                )
            if goal["state"] == "blocked":
                _finish_run(
                    run_id, "blocked", reason="goal_blocked",
                    steps_attempted=len(attempts), last_step_id=last_step_id,
                )
                return _run_response(
                    run_id=run_id, goal=goal, state="blocked", reason="goal_blocked",
                    attempts=attempts,
                )

            current_id = goal.get("current_step_id")
            step = next((item for item in goal["steps"] if item["id"] == current_id), None)
            if step is None:
                _set_plan_state(goal["plan_id"], "failed")
                goal = goals.sync_goal_progress(goal_id) or goal
                _finish_run(
                    run_id, "blocked", reason="missing_current_step",
                    steps_attempted=len(attempts), last_step_id=last_step_id,
                )
                return _run_response(
                    run_id=run_id, goal=goal, state="blocked", reason="missing_current_step",
                    attempts=attempts,
                )

            if step["state"] == "awaiting_approval":
                _set_plan_state(goal["plan_id"], "awaiting_approval")
                _finish_run(
                    run_id, "awaiting_approval", reason="approval_required",
                    steps_attempted=len(attempts), last_step_id=step["id"],
                )
                return _run_response(
                    run_id=run_id, goal=goal, state="awaiting_approval",
                    reason="approval_required", attempts=attempts,
                )
            if step["state"] != "ready":
                _finish_run(
                    run_id, "blocked", reason="dependency_not_ready",
                    steps_attempted=len(attempts), last_step_id=step["id"],
                )
                return _run_response(
                    run_id=run_id, goal=goal, state="blocked",
                    reason="dependency_not_ready", attempts=attempts,
                )

            action = str(step["action"])
            if action not in TOOLS:
                _set_plan_state(goal["plan_id"], "failed")
                goal = goals.sync_goal_progress(goal_id) or goal
                _finish_run(
                    run_id, "blocked", reason="unregistered_action",
                    steps_attempted=len(attempts), last_step_id=step["id"],
                )
                return _run_response(
                    run_id=run_id, goal=goal, state="blocked", reason="unregistered_action",
                    attempts=attempts,
                )

            _set_plan_state(goal["plan_id"], "running")
            result = await execution.execute_tool(
                request_id=goal["request_id"],
                plan_id=goal["plan_id"],
                step_index=int(step["position"]),
                action=action,
                arguments=dict(step.get("arguments") or {}),
            )
            last_step_id = step["id"]
            safe = _safe_execution_summary(result, step)
            attempts.append(safe)

            state = result.get("state")
            if state == "completed":
                goals.sync_goal_progress(goal_id)
                continue
            if state == "approval_required":
                _set_plan_state(goal["plan_id"], "awaiting_approval")
                goal = goals.sync_goal_progress(goal_id) or goal
                _finish_run(
                    run_id, "awaiting_approval", reason="approval_required",
                    steps_attempted=len(attempts), last_step_id=last_step_id,
                )
                record_audit(
                    "goal.run_waiting_approval",
                    {
                        "goal_id": goal_id,
                        "run_id": run_id,
                        "step_id": last_step_id,
                        "approval_id": (result.get("approval") or {}).get("id"),
                    },
                    goal["request_id"],
                )
                return _run_response(
                    run_id=run_id, goal=goal, state="awaiting_approval",
                    reason="approval_required", attempts=attempts,
                )

            _set_plan_state(goal["plan_id"], "failed")
            goal = goals.sync_goal_progress(goal_id) or goal
            _finish_run(
                run_id, "blocked", reason="step_failed_or_denied",
                steps_attempted=len(attempts), last_step_id=last_step_id,
            )
            record_audit(
                "goal.run_blocked",
                {"goal_id": goal_id, "run_id": run_id, "step_id": last_step_id, "execution_state": state},
                goal["request_id"],
            )
            return _run_response(
                run_id=run_id, goal=goal, state="blocked",
                reason="step_failed_or_denied", attempts=attempts,
            )

        _set_plan_state(goal["plan_id"], "failed")
        goal = goals.sync_goal_progress(goal_id) or goal
        _finish_run(
            run_id, "blocked", reason="step_budget_exhausted",
            steps_attempted=len(attempts), last_step_id=last_step_id,
        )
        return _run_response(
            run_id=run_id, goal=goal, state="blocked",
            reason="step_budget_exhausted", attempts=attempts,
        )
    except Exception as exc:
        try:
            _finish_run(
                run_id, "blocked", reason=type(exc).__name__,
                steps_attempted=len(attempts), last_step_id=last_step_id,
            )
        except Exception:
            pass
        record_audit(
            "goal.run_failed",
            {"goal_id": goal_id, "run_id": run_id, "error_type": type(exc).__name__},
            goal["request_id"],
        )
        raise


def recover_interrupted_runs() -> int:
    """Close stale run leases after process restart; never auto-replay a step."""
    initialise()
    with connection() as db:
        rows = db.execute("SELECT id FROM agent_goal_runs WHERE state = 'running'").fetchall()
        db.execute(
            """UPDATE agent_goal_runs
               SET state = 'interrupted', stop_reason = 'core_process_interrupted',
                   completed_at = CURRENT_TIMESTAMP
               WHERE state = 'running'"""
        )
    return len(rows)


def status() -> dict:
    initialise()
    with connection() as db:
        rows = db.execute("SELECT state, COUNT(*) AS count FROM agent_goal_runs GROUP BY state").fetchall()
    counts = Counter({str(row["state"]): int(row["count"]) for row in rows})
    return {
        "mode": LOOP_MODE,
        "runs": sum(counts.values()),
        "states": dict(counts),
        "max_steps_per_run": MAX_STEPS_PER_RUN,
        "automatic_start": False,
        "automatic_safe_continuation": True,
        "approval_resume": True,
        "approval_policy": "existing_exact_scope",
        "executor": "existing_policy_gated_executor",
        "verification": "existing_per_tool_verification",
        "adds_or_replans_steps": False,
        "cloud_models": False,
        "restart_auto_replay": False,
    }


async def _continue_after_approval(approval_id: str, approved: bool, base_result: dict) -> dict:
    """Resume only when a resolved approval belongs to a durable agent goal."""
    with connection() as db:
        row = db.execute(
            "SELECT plan_id, request_id FROM approvals WHERE id = ?",
            (approval_id,),
        ).fetchone()
        goal_row = None
        if row is not None and row["plan_id"] is not None:
            goal_row = db.execute(
                "SELECT id FROM agent_goals WHERE plan_id = ?",
                (row["plan_id"],),
            ).fetchone()

    if goal_row is None:
        return base_result

    goal_id = str(goal_row["id"])
    if not approved:
        goal = goals.sync_goal_progress(goal_id)
        record_audit(
            "goal.approval_rejected",
            {"goal_id": goal_id, "approval_id": approval_id},
            row["request_id"],
        )
        return {
            **base_result,
            "goal": {
                "id": goal_id,
                "state": goal.get("state") if goal else "blocked",
                "continued": False,
            },
        }

    continued = await run_goal(goal_id, trigger="approval")
    return {
        **base_result,
        "goal": {
            "id": goal_id,
            "state": continued.get("state"),
            "continued": True,
            "run_id": continued.get("run_id"),
            "stop_reason": continued.get("stop_reason"),
        },
    }


def install_hooks() -> None:
    """Bind approval continuation and restart run cleanup without changing APIs."""
    global _HOOKS_INSTALLED
    if _HOOKS_INSTALLED:
        return

    from . import approval_resume, recovery

    original_resolve = approval_resume.resolve_and_resume
    original_recover = recovery.recover_interrupted_work

    async def resolve_and_continue(approval_id: str, approved: bool) -> dict:
        base = await original_resolve(approval_id, approved)
        if base.get("state") in {"not_found", "conflict", "scope_mismatch"}:
            return base
        return await _continue_after_approval(approval_id, approved, base)

    def recover_with_run_cleanup() -> dict:
        result = original_recover()
        recover_interrupted_runs()
        return result

    approval_resume.resolve_and_resume = resolve_and_continue
    recovery.recover_interrupted_work = recover_with_run_cleanup
    _HOOKS_INSTALLED = True


@router.get("/v1/core/agent-loop/status")
async def agent_loop_status():
    return status()


@router.post("/v1/core/goals/{goal_id}/run")
async def run_goal_route(goal_id: str):
    result = await run_goal(goal_id, trigger="owner")
    if result.get("state") == "not_found":
        raise HTTPException(status_code=404, detail="Goal not found")
    if result.get("stop_reason") == "already_running":
        raise HTTPException(status_code=409, detail=result)
    return result

"""Content-minimised agent observability for Alfred Phase 5H.

Phase 5H is read-only. It derives an operator-facing Today/Agent Activity view
from existing durable Phase 5A-G metadata and never executes a tool, resolves an
approval, reads connected-source payloads, or stores a second execution history.

The public payload deliberately excludes goal text, step arguments, tool results,
verification payloads, recipe parameter values, approval scope hashes and any
connected-source content. It contains only identifiers, action names, states,
counts, deterministic policy/risk/effect metadata, timestamps and generic
rationales.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter

from . import (
    agent_loop,
    approval_engine,
    config,
    execution,
    execution_reliability,
    goals,
    reusable_workflows,
)
from .core import decide
from .db import connection
from .integrations import action_owner


OBSERVABILITY_MODE = "agent_observability_v1"
CONTENT_POLICY = "metadata_only"
MAX_ACTIVE_GOALS = 20
MAX_RECENT_ITEMS = 30
router = APIRouter(tags=["core-agent-observability"])


def _initialise_sources() -> None:
    goals.initialise()
    agent_loop.initialise()
    approval_engine.initialise()
    reusable_workflows.initialise()
    execution.initialise_execution_store()
    execution_reliability.initialise()


def _today_window() -> tuple[str, str, str]:
    try:
        local_tz = ZoneInfo(config.settings.timezone)
    except Exception:
        local_tz = ZoneInfo("Europe/London")
    now_local = datetime.now(local_tz)
    start_local = datetime.combine(now_local.date(), time.min, local_tz)
    end_local = start_local + timedelta(days=1)
    start_utc = start_local.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    end_utc = end_local.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return now_local.date().isoformat(), start_utc, end_utc


def _recipe_meta(goal_id: str) -> dict | None:
    with connection() as db:
        row = db.execute(
            """SELECT recipe_id, recipe_version, id AS instance_id
               FROM agent_recipe_instances WHERE goal_id = ? LIMIT 1""",
            (goal_id,),
        ).fetchone()
    if row is None:
        return None
    recipe_id = str(row["recipe_id"])
    definition = reusable_workflows.RECIPES.get(recipe_id)
    return {
        "id": recipe_id,
        "title": definition.title if definition else "Reusable workflow",
        "version": int(row["recipe_version"]),
        "instance_id": str(row["instance_id"]),
    }


def _step_state_counts(goal_id: str) -> dict[str, int]:
    with connection() as db:
        rows = db.execute(
            "SELECT state, COUNT(*) AS count FROM agent_goal_steps WHERE goal_id = ? GROUP BY state",
            (goal_id,),
        ).fetchall()
    return {str(row["state"]): int(row["count"]) for row in rows}


def _pending_approval_for(plan_id: str, step_position: int) -> dict | None:
    with connection() as db:
        row = db.execute(
            """SELECT c.approval_id, c.risk_level, c.effect, c.dependency_count,
                      c.verified_dependency_count, c.binding_count
               FROM agent_approval_context c
               JOIN approvals a ON a.id = c.approval_id
               WHERE c.plan_id = ? AND c.step_position = ? AND a.state = 'pending'
               ORDER BY a.created_at DESC LIMIT 1""",
            (plan_id, step_position),
        ).fetchone()
    if row is None:
        return None
    item = dict(row)
    return {
        "id": str(item["approval_id"]),
        "risk_level": str(item["risk_level"]),
        "effect": str(item["effect"]),
        "dependency_count": int(item["dependency_count"]),
        "verified_dependency_count": int(item["verified_dependency_count"]),
        "binding_count": int(item["binding_count"]),
    }


def _step_why(*, state: str, dependency_count: int, recipe: dict | None) -> str:
    if state == "awaiting_approval":
        return "Waiting for exact-scope owner approval before the planned change can run."
    if state == "running":
        return "Executing through Alfred's existing policy-gated and verified executor."
    if state == "failed":
        return "This planned step failed and requires attention before the goal can continue."
    if state == "pending":
        if dependency_count:
            return f"Waiting for {dependency_count} prerequisite step(s) to complete and verify."
        return "Waiting for the durable plan to make this step ready."
    if recipe is not None:
        return f"Next planned step selected by the reusable recipe “{recipe['title']}”."
    return "Next planned step in the durable goal; normal policy and verification still apply."


def _current_step(goal_row: dict, recipe: dict | None) -> dict | None:
    current_step_id = goal_row.get("current_step_id")
    if not isinstance(current_step_id, str) or not current_step_id:
        return None
    with connection() as db:
        row = db.execute(
            """SELECT id, position, action, depends_on, state, updated_at
               FROM agent_goal_steps WHERE id = ? LIMIT 1""",
            (current_step_id,),
        ).fetchone()
    if row is None:
        return None
    try:
        dependencies = json.loads(row["depends_on"] or "[]")
    except json.JSONDecodeError:
        dependencies = []
    dependency_count = len(dependencies) if isinstance(dependencies, list) else 0
    action = str(row["action"])
    state = str(row["state"])
    policy = decide(action)
    result = {
        "id": str(row["id"]),
        "position": int(row["position"]),
        "action": action,
        "state": state,
        "integration": action_owner(action),
        "risk_level": policy.level,
        "dependency_count": dependency_count,
        "why": _step_why(state=state, dependency_count=dependency_count, recipe=recipe),
        "updated_at": str(row["updated_at"]),
    }
    pending = _pending_approval_for(str(goal_row["plan_id"]), int(row["position"]))
    if pending is not None:
        result["approval"] = pending
    return result


def _active_goals() -> list[dict]:
    with connection() as db:
        rows = db.execute(
            """SELECT id, plan_id, state, current_step_id, created_at, updated_at
               FROM agent_goals
               WHERE state NOT IN ('completed', 'cancelled')
               ORDER BY updated_at DESC LIMIT ?""",
            (MAX_ACTIVE_GOALS,),
        ).fetchall()
    items: list[dict] = []
    for row in rows:
        goal = dict(row)
        recipe = _recipe_meta(str(goal["id"]))
        counts = _step_state_counts(str(goal["id"]))
        item = {
            "goal_id": str(goal["id"]),
            "plan_id": str(goal["plan_id"]),
            "state": str(goal["state"]),
            "step_counts": counts,
            "current_step": _current_step(goal, recipe),
            "created_at": str(goal["created_at"]),
            "updated_at": str(goal["updated_at"]),
        }
        if recipe is not None:
            item["recipe"] = recipe
        items.append(item)
    return items


def _waiting_approvals() -> list[dict]:
    items: list[dict] = []
    for raw in approval_engine.pending_context(MAX_RECENT_ITEMS):
        goal_id = str(raw["goal_id"])
        recipe = _recipe_meta(goal_id)
        item = {
            "approval_id": str(raw["approval_id"]),
            "goal_id": goal_id,
            "plan_id": str(raw["plan_id"]),
            "step_position": int(raw["step_position"]),
            "step_count": int(raw["step_count"]),
            "action": str(raw["action"]),
            "integration": raw.get("integration"),
            "risk_level": str(raw["risk_level"]),
            "effect": str(raw["effect"]),
            "dependency_count": int(raw["dependency_count"]),
            "verified_dependency_count": int(raw["verified_dependency_count"]),
            "binding_count": int(raw["binding_count"]),
            "why": str(raw["why"]),
            "risk_explanation": str(raw["risk_explanation"]),
            "created_at": str(raw["created_at"]),
        }
        if recipe is not None:
            item["recipe"] = recipe
        items.append(item)
    return items


def _completed_work(start_utc: str, end_utc: str) -> list[dict]:
    with connection() as db:
        rows = db.execute(
            """SELECT execution_id, plan_id, step_index, action, effect_class,
                      outcome_state, verification_state, attempt_number, created_at
               FROM core_execution_receipts
               WHERE created_at >= ? AND created_at < ?
                 AND outcome_state = 'completed' AND verification_state = 'verified'
               ORDER BY created_at DESC LIMIT ?""",
            (start_utc, end_utc, MAX_RECENT_ITEMS),
        ).fetchall()
    return [
        {
            "execution_id": str(row["execution_id"]),
            "plan_id": str(row["plan_id"]) if row["plan_id"] is not None else None,
            "step_position": int(row["step_index"]) if row["step_index"] is not None else None,
            "action": str(row["action"]),
            "effect_class": str(row["effect_class"]),
            "outcome": "verified_completed",
            "attempt_number": int(row["attempt_number"]),
            "created_at": str(row["created_at"]),
        }
        for row in rows
    ]


def _attention_items(start_utc: str, end_utc: str) -> list[dict]:
    with connection() as db:
        receipt_rows = db.execute(
            """SELECT execution_id, plan_id, step_index, action, effect_class,
                      outcome_state, verification_state, error_type, attempt_number, created_at
               FROM core_execution_receipts
               WHERE created_at >= ? AND created_at < ?
                 AND (outcome_state != 'completed' OR verification_state != 'verified' OR error_type IS NOT NULL)
               ORDER BY created_at DESC LIMIT ?""",
            (start_utc, end_utc, MAX_RECENT_ITEMS),
        ).fetchall()
        operation_rows = db.execute(
            """SELECT execution_id, plan_id, step_index, action, effect_class,
                      state, attempt_count, updated_at
               FROM core_reliability_operations
               WHERE updated_at >= ? AND updated_at < ?
                 AND state IN ('reconciliation_required', 'retry_exhausted', 'failed_terminal')
               ORDER BY updated_at DESC LIMIT ?""",
            (start_utc, end_utc, MAX_RECENT_ITEMS),
        ).fetchall()

    items: list[dict] = []
    seen: set[tuple[str | None, str, str]] = set()
    for row in receipt_rows:
        key = (str(row["execution_id"]), str(row["action"]), str(row["created_at"]))
        seen.add(key)
        items.append({
            "execution_id": str(row["execution_id"]),
            "plan_id": str(row["plan_id"]) if row["plan_id"] is not None else None,
            "step_position": int(row["step_index"]) if row["step_index"] is not None else None,
            "action": str(row["action"]),
            "effect_class": str(row["effect_class"]),
            "state": str(row["outcome_state"]),
            "verification_state": str(row["verification_state"]),
            "error_type": str(row["error_type"]) if row["error_type"] else None,
            "attempt_count": int(row["attempt_number"]),
            "why": "Execution did not reach a verified completed state and needs attention.",
            "updated_at": str(row["created_at"]),
        })
    for row in operation_rows:
        key = (
            str(row["execution_id"]) if row["execution_id"] else None,
            str(row["action"]),
            str(row["updated_at"]),
        )
        if key in seen:
            continue
        state = str(row["state"])
        why = (
            "Mutation outcome is ambiguous; Phase 5E requires reconciliation before any retry."
            if state == "reconciliation_required"
            else "Automatic recovery stopped after the bounded retry policy was exhausted."
            if state == "retry_exhausted"
            else "Execution failed deterministically and will not be retried automatically."
        )
        items.append({
            "execution_id": str(row["execution_id"]) if row["execution_id"] else None,
            "plan_id": str(row["plan_id"]) if row["plan_id"] is not None else None,
            "step_position": int(row["step_index"]) if row["step_index"] is not None else None,
            "action": str(row["action"]),
            "effect_class": str(row["effect_class"]),
            "state": state,
            "verification_state": "attention_required",
            "error_type": None,
            "attempt_count": int(row["attempt_count"]),
            "why": why,
            "updated_at": str(row["updated_at"]),
        })
    items.sort(key=lambda item: item["updated_at"], reverse=True)
    return items[:MAX_RECENT_ITEMS]


def _recipe_runs(start_utc: str, end_utc: str) -> list[dict]:
    with connection() as db:
        instances = db.execute(
            """SELECT id, recipe_id, recipe_version, workflow_id, goal_id, plan_id, created_at
               FROM agent_recipe_instances
               WHERE created_at >= ? AND created_at < ?
               ORDER BY created_at DESC LIMIT ?""",
            (start_utc, end_utc, MAX_RECENT_ITEMS),
        ).fetchall()
        items: list[dict] = []
        for row in instances:
            run = db.execute(
                """SELECT id, state, stop_reason, steps_attempted, started_at, completed_at
                   FROM agent_goal_runs WHERE goal_id = ?
                   ORDER BY started_at DESC LIMIT 1""",
                (row["goal_id"],),
            ).fetchone()
            recipe_id = str(row["recipe_id"])
            definition = reusable_workflows.RECIPES.get(recipe_id)
            items.append({
                "instance_id": str(row["id"]),
                "recipe_id": recipe_id,
                "recipe_title": definition.title if definition else "Reusable workflow",
                "recipe_version": int(row["recipe_version"]),
                "workflow_id": str(row["workflow_id"]),
                "goal_id": str(row["goal_id"]),
                "plan_id": str(row["plan_id"]),
                "run": (
                    {
                        "run_id": str(run["id"]),
                        "state": str(run["state"]),
                        "stop_reason": str(run["stop_reason"]) if run["stop_reason"] else None,
                        "steps_attempted": int(run["steps_attempted"]),
                        "started_at": str(run["started_at"]),
                        "completed_at": str(run["completed_at"]) if run["completed_at"] else None,
                    }
                    if run is not None
                    else None
                ),
                "created_at": str(row["created_at"]),
            })
    return items


def today_view() -> dict:
    _initialise_sources()
    local_date, start_utc, end_utc = _today_window()
    active = _active_goals()
    approvals = _waiting_approvals()
    completed = _completed_work(start_utc, end_utc)
    attention = _attention_items(start_utc, end_utc)
    recipes = _recipe_runs(start_utc, end_utc)
    states = Counter(str(item["state"]) for item in active)
    return {
        "mode": OBSERVABILITY_MODE,
        "date": local_date,
        "content_policy": CONTENT_POLICY,
        "read_only": True,
        "cloud_models": False,
        "counts": {
            "active_goals": len(active),
            "waiting_approvals": len(approvals),
            "completed_work_today": len(completed),
            "attention_items_today": len(attention),
            "recipe_runs_today": len(recipes),
        },
        "active_goal_states": dict(states),
        "active_goals": active,
        "waiting_approvals": approvals,
        "completed_work": completed,
        "attention_items": attention,
        "recipe_runs": recipes,
        "explanations": {
            "source": "deterministic_metadata_v1",
            "policy": "existing_phase5a_to_phase5g_state_only",
            "connected_content_exposed": False,
            "raw_arguments_exposed": False,
            "tool_results_exposed": False,
            "recipe_parameters_exposed": False,
            "scope_hashes_exposed": False,
        },
    }


def status() -> dict:
    view = today_view()
    return {
        "mode": OBSERVABILITY_MODE,
        "content_policy": CONTENT_POLICY,
        "read_only": True,
        "today_view": True,
        "active_goals": view["counts"]["active_goals"],
        "waiting_approvals": view["counts"]["waiting_approvals"],
        "attention_items_today": view["counts"]["attention_items_today"],
        "deterministic_explanations": True,
        "connected_content_exposed": False,
        "raw_arguments_exposed": False,
        "tool_results_exposed": False,
        "recipe_parameters_exposed": False,
        "scope_hashes_exposed": False,
        "mutations": False,
        "cloud_models": False,
    }


@router.get("/v1/core/observability/status")
async def observability_status():
    return status()


@router.get("/v1/core/observability/today")
async def observability_today():
    return today_view()

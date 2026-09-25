"""Durable goal and plan state for Alfred Phase 5A.

Phase 5A deliberately stops at planning. Goals and their ordered dependency graph
are persisted locally on the Dell and mapped onto Alfred's existing policy-gated
`plans` executor. Nothing in this module automatically executes a tool, resolves
an approval, calls a model or performs an external mutation.
"""

from __future__ import annotations

import json
from collections import Counter
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .core import TOOLS
from .db import connection, record_audit


GOAL_MODE = "durable_goals_v1"
GOAL_STATES = {"ready", "active", "awaiting_approval", "blocked", "completed", "cancelled"}
STEP_STATES = {"pending", "ready", "running", "awaiting_approval", "completed", "failed"}
router = APIRouter(prefix="/v1/core/goals", tags=["core-goals"])


class GoalStepRequest(BaseModel):
    action: str = Field(min_length=1, max_length=120)
    arguments: dict = Field(default_factory=dict)
    depends_on: list[int] = Field(default_factory=list, max_length=20)


class GoalCreateRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=1000)
    steps: list[GoalStepRequest] = Field(min_length=1, max_length=20)
    request_id: str | None = Field(default=None, min_length=1, max_length=64)


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS agent_goals (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            plan_id TEXT NOT NULL UNIQUE,
            goal TEXT NOT NULL,
            state TEXT NOT NULL,
            current_step_id TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS agent_goals_state ON agent_goals(state, updated_at DESC)")
        db.execute("""CREATE TABLE IF NOT EXISTS agent_goal_steps (
            id TEXT PRIMARY KEY,
            goal_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            action TEXT NOT NULL,
            arguments TEXT NOT NULL,
            depends_on TEXT NOT NULL,
            state TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(goal_id, position)
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS agent_goal_steps_goal ON agent_goal_steps(goal_id, position)")


def _encode(value) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True, default=str)


def _decode_dict(value: str) -> dict:
    payload = json.loads(value)
    return payload if isinstance(payload, dict) else {}


def _decode_list(value: str) -> list:
    payload = json.loads(value)
    return payload if isinstance(payload, list) else []


def _validate_steps(steps: list[dict]) -> list[dict]:
    """Validate a bounded, acyclic plan without executing or checking live availability."""
    if not isinstance(steps, list) or not 1 <= len(steps) <= 20:
        raise ValueError("A goal requires between 1 and 20 steps")

    clean: list[dict] = []
    for index, raw in enumerate(steps):
        if not isinstance(raw, dict):
            raise ValueError(f"Invalid goal step {index}")
        action = raw.get("action")
        arguments = raw.get("arguments", {})
        dependencies = raw.get("depends_on", [])
        if not isinstance(action, str) or not action.strip() or len(action) > 120:
            raise ValueError(f"Invalid action in goal step {index}")
        if action not in TOOLS:
            raise ValueError(f"Unregistered action in goal step {index}: {action}")
        if not isinstance(arguments, dict):
            raise ValueError(f"Invalid arguments in goal step {index}")
        if not isinstance(dependencies, list) or len(dependencies) > 20:
            raise ValueError(f"Invalid dependencies in goal step {index}")
        if any(not isinstance(dep, int) or isinstance(dep, bool) for dep in dependencies):
            raise ValueError(f"Dependencies must be step indexes in goal step {index}")
        if len(set(dependencies)) != len(dependencies):
            raise ValueError(f"Duplicate dependency in goal step {index}")
        if any(dep < 0 or dep >= index for dep in dependencies):
            raise ValueError(f"Dependencies must refer only to earlier steps in goal step {index}")
        clean.append({
            "action": action.strip(),
            "arguments": dict(arguments),
            "depends_on": list(dependencies),
        })
    return clean


def create_goal(*, goal: str, steps: list[dict], request_id: str | None = None) -> dict:
    initialise()
    clean_goal = goal.strip() if isinstance(goal, str) else ""
    if not clean_goal or len(clean_goal) > 1000:
        raise ValueError("Goal must contain between 1 and 1000 characters")
    clean_steps = _validate_steps(steps)

    goal_id = str(uuid4())
    plan_id = str(uuid4())
    owner_request_id = request_id or f"goal:{goal_id}"
    if not isinstance(owner_request_id, str) or not 1 <= len(owner_request_id) <= 64:
        raise ValueError("Invalid request id")

    step_ids = [str(uuid4()) for _ in clean_steps]
    plan_steps: list[dict] = []
    stored_steps: list[tuple] = []
    for index, step in enumerate(clean_steps):
        dependency_ids = [step_ids[position] for position in step["depends_on"]]
        state = "ready" if not dependency_ids else "pending"
        plan_steps.append({
            "action": step["action"],
            "arguments": step["arguments"],
            "goal_step_id": step_ids[index],
            "depends_on": dependency_ids,
        })
        stored_steps.append((
            step_ids[index], goal_id, index, step["action"], _encode(step["arguments"]),
            _encode(dependency_ids), state,
        ))

    with connection() as db:
        db.execute(
            "INSERT INTO plans (id, request_id, goal, state, steps) VALUES (?, ?, ?, 'draft', ?)",
            (plan_id, owner_request_id, clean_goal, _encode(plan_steps)),
        )
        db.execute(
            """INSERT INTO agent_goals
               (id, request_id, plan_id, goal, state, current_step_id)
               VALUES (?, ?, ?, ?, 'ready', ?)""",
            (goal_id, owner_request_id, plan_id, clean_goal, step_ids[0]),
        )
        db.executemany(
            """INSERT INTO agent_goal_steps
               (id, goal_id, position, action, arguments, depends_on, state)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            stored_steps,
        )

    record_audit(
        "goal.created",
        {"goal_id": goal_id, "plan_id": plan_id, "step_count": len(clean_steps), "content_stored_local": True},
        owner_request_id,
    )
    return get_goal(goal_id, sync=False) or {}


def _raw_goal(goal_id: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute(
            """SELECT id, request_id, plan_id, goal, state, current_step_id, version,
                      created_at, updated_at
               FROM agent_goals WHERE id = ?""",
            (goal_id,),
        ).fetchone()
        if row is None:
            return None
        step_rows = db.execute(
            """SELECT id, position, action, arguments, depends_on, state, created_at, updated_at
               FROM agent_goal_steps WHERE goal_id = ? ORDER BY position ASC""",
            (goal_id,),
        ).fetchall()
    result = dict(row)
    result["steps"] = [
        {
            **dict(step),
            "arguments": _decode_dict(step["arguments"]),
            "depends_on": _decode_list(step["depends_on"]),
        }
        for step in step_rows
    ]
    return result


def sync_goal_progress(goal_id: str) -> dict | None:
    """Reconstruct durable step/goal state from existing executions and approvals."""
    goal = _raw_goal(goal_id)
    if goal is None:
        return None
    if goal["state"] == "cancelled":
        return goal

    with connection() as db:
        plan = db.execute("SELECT state FROM plans WHERE id = ?", (goal["plan_id"],)).fetchone()
        execution_rows = db.execute(
            """SELECT step_index, state FROM core_executions
               WHERE plan_id = ? ORDER BY created_at ASC""",
            (goal["plan_id"],),
        ).fetchall() if db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_executions'"
        ).fetchone() else []
        approval_rows = db.execute(
            """SELECT step_index, state FROM approvals
               WHERE plan_id = ? ORDER BY created_at ASC""",
            (goal["plan_id"],),
        ).fetchall()

    executions = {int(row["step_index"]): str(row["state"]) for row in execution_rows if row["step_index"] is not None}
    approvals = {int(row["step_index"]): str(row["state"]) for row in approval_rows if row["step_index"] is not None}
    completed_ids: set[str] = set()
    derived: list[tuple[str, str]] = []

    for step in goal["steps"]:
        position = int(step["position"])
        execution_state = executions.get(position)
        approval_state = approvals.get(position)
        if execution_state == "completed":
            state = "completed"
        elif execution_state == "running":
            state = "running"
        elif execution_state in {"failed", "interrupted"}:
            state = "failed"
        elif approval_state == "pending":
            state = "awaiting_approval"
        elif approval_state == "rejected":
            state = "failed"
        else:
            dependencies = set(step.get("depends_on") or [])
            state = "ready" if dependencies.issubset(completed_ids) else "pending"
        if state == "completed":
            completed_ids.add(step["id"])
        derived.append((step["id"], state))

    states = [state for _, state in derived]
    plan_state = str(plan["state"]) if plan else "missing"
    if states and all(state == "completed" for state in states):
        goal_state = "completed"
    elif plan_state in {"failed", "interrupted"} or "failed" in states:
        goal_state = "blocked"
    elif "awaiting_approval" in states:
        goal_state = "awaiting_approval"
    elif "running" in states or "completed" in states:
        goal_state = "active"
    else:
        goal_state = "ready"

    current_step_id = next((step_id for step_id, state in derived if state != "completed"), None)
    with connection() as db:
        for step_id, state in derived:
            db.execute(
                """UPDATE agent_goal_steps SET state = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND state != ?""",
                (state, step_id, state),
            )
        db.execute(
            """UPDATE agent_goals
               SET state = ?, current_step_id = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (goal_state, current_step_id, goal_id),
        )
    return _raw_goal(goal_id)


def get_goal(goal_id: str, *, sync: bool = True) -> dict | None:
    return sync_goal_progress(goal_id) if sync else _raw_goal(goal_id)


def list_goals(*, limit: int = 50, state: str | None = None) -> list[dict]:
    initialise()
    size = max(1, min(int(limit), 100))
    if state is not None and state not in GOAL_STATES:
        raise ValueError("Invalid goal state")
    with connection() as db:
        if state:
            rows = db.execute(
                "SELECT id FROM agent_goals WHERE state = ? ORDER BY updated_at DESC LIMIT ?",
                (state, size),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT id FROM agent_goals ORDER BY updated_at DESC LIMIT ?", (size,)
            ).fetchall()
    items = []
    for row in rows:
        item = sync_goal_progress(str(row["id"]))
        if item is not None and (state is None or item.get("state") == state):
            items.append(item)
    return items


def cancel_goal(goal_id: str) -> dict | None:
    goal = _raw_goal(goal_id)
    if goal is None:
        return None
    if goal["state"] == "completed":
        raise ValueError("Completed goals cannot be cancelled")
    if goal["state"] == "cancelled":
        return goal
    with connection() as db:
        db.execute(
            "UPDATE agent_goals SET state = 'cancelled', current_step_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (goal_id,),
        )
        db.execute(
            "UPDATE plans SET state = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (goal["plan_id"],),
        )
    record_audit("goal.cancelled", {"goal_id": goal_id, "plan_id": goal["plan_id"]}, goal["request_id"])
    return _raw_goal(goal_id)


def recover_after_restart() -> dict:
    """Reconcile nonterminal goals after Core has marked interrupted plans/executions."""
    initialise()
    with connection() as db:
        rows = db.execute(
            "SELECT id FROM agent_goals WHERE state NOT IN ('completed', 'cancelled')"
        ).fetchall()
    counts: Counter[str] = Counter()
    for row in rows:
        item = sync_goal_progress(str(row["id"]))
        if item is not None:
            counts[str(item["state"])] += 1
    return {"goals": len(rows), "states": dict(counts)}


def status() -> dict:
    initialise()
    with connection() as db:
        rows = db.execute("SELECT state, COUNT(*) AS count FROM agent_goals GROUP BY state").fetchall()
        steps = db.execute("SELECT COUNT(*) FROM agent_goal_steps").fetchone()[0]
    return {
        "mode": GOAL_MODE,
        "states": {str(row["state"]): int(row["count"]) for row in rows},
        "goals": sum(int(row["count"]) for row in rows),
        "steps": int(steps),
        "max_steps_per_goal": 20,
        "dependency_policy": "earlier_steps_only",
        "automatic_execution": False,
        "executor": "existing_policy_gated_plan_executor",
        "durable": True,
        "cloud_models": False,
    }


@router.get("/status")
async def goal_status():
    return status()


@router.post("")
async def create_goal_route(request: GoalCreateRequest):
    try:
        return create_goal(
            goal=request.goal,
            steps=[step.model_dump() for step in request.steps],
            request_id=request.request_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("")
async def list_goals_route(state: str | None = None, limit: int = 50):
    try:
        return {"items": list_goals(state=state, limit=limit)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{goal_id}")
async def get_goal_route(goal_id: str):
    item = get_goal(goal_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    return item


@router.post("/{goal_id}/cancel")
async def cancel_goal_route(goal_id: str):
    try:
        item = cancel_goal(goal_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if item is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    return item

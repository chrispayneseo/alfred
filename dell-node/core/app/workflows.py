"""Verified local data hand-off for Alfred Phase 5C multi-tool workflows.

A workflow is a Phase 5A durable goal plus a bounded set of bindings that copy a
single scalar value from an earlier *verified completed* step into a later
step's top-level argument. Bindings never evaluate code, call a model, copy
whole objects, or bypass the existing executor/approval boundary.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .db import connection, record_audit
from . import goals


WORKFLOW_MODE = "verified_multi_tool_workflows_v1"
MAX_BINDINGS_PER_STEP = 8
MAX_BOUND_STRING_CHARS = 4000
_TARGET_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_SOURCE_PART_RE = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,3})$")
router = APIRouter(tags=["core-workflows"])


class WorkflowBindingRequest(BaseModel):
    target: str = Field(min_length=1, max_length=64)
    source_step: int = Field(ge=0, le=19)
    source_path: str = Field(min_length=1, max_length=240)


class WorkflowStepRequest(BaseModel):
    action: str = Field(min_length=1, max_length=120)
    arguments: dict = Field(default_factory=dict)
    depends_on: list[int] = Field(default_factory=list, max_length=20)
    bindings: list[WorkflowBindingRequest] = Field(default_factory=list, max_length=MAX_BINDINGS_PER_STEP)


class WorkflowCreateRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=1000)
    steps: list[WorkflowStepRequest] = Field(min_length=1, max_length=20)
    request_id: str | None = Field(default=None, min_length=1, max_length=64)


class WorkflowBindingError(RuntimeError):
    pass


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS agent_workflows (
            id TEXT PRIMARY KEY,
            goal_id TEXT NOT NULL UNIQUE,
            plan_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS agent_workflow_bindings (
            id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            step_position INTEGER NOT NULL,
            target TEXT NOT NULL,
            source_step INTEGER NOT NULL,
            source_path TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(workflow_id, step_position, target)
        )""")
        db.execute(
            "CREATE INDEX IF NOT EXISTS agent_workflow_bindings_step "
            "ON agent_workflow_bindings(workflow_id, step_position)"
        )


def _validate_source_path(path: str) -> list[str]:
    if not isinstance(path, str) or not path or len(path) > 240:
        raise ValueError("Invalid workflow source path")
    parts = path.split(".")
    if not 1 <= len(parts) <= 8 or any(not _SOURCE_PART_RE.fullmatch(part) for part in parts):
        raise ValueError("Workflow source paths must use bounded dotted keys or indexes")
    return parts


def _validate_workflow_steps(steps: list[dict]) -> tuple[list[dict], list[dict]]:
    """Validate the goal steps plus all data bindings before storing anything."""
    if not isinstance(steps, list) or not 1 <= len(steps) <= 20:
        raise ValueError("A workflow requires between 1 and 20 steps")

    goal_steps: list[dict] = []
    bindings: list[dict] = []
    for index, raw in enumerate(steps):
        if not isinstance(raw, dict):
            raise ValueError(f"Invalid workflow step {index}")
        action = raw.get("action")
        arguments = raw.get("arguments", {})
        depends_on = raw.get("depends_on", [])
        raw_bindings = raw.get("bindings", [])
        # Reuse the Phase 5A plan validator for action registration, argument shape
        # and the earlier-step-only dependency rule.
        validated = goals._validate_steps([*goal_steps, {
            "action": action,
            "arguments": arguments,
            "depends_on": depends_on,
        }])[-1]
        goal_steps.append(validated)

        if not isinstance(raw_bindings, list) or len(raw_bindings) > MAX_BINDINGS_PER_STEP:
            raise ValueError(f"Too many bindings in workflow step {index}")
        seen_targets: set[str] = set()
        for binding in raw_bindings:
            if not isinstance(binding, dict):
                raise ValueError(f"Invalid binding in workflow step {index}")
            target = binding.get("target")
            source_step = binding.get("source_step")
            source_path = binding.get("source_path")
            if not isinstance(target, str) or not _TARGET_RE.fullmatch(target):
                raise ValueError(f"Invalid binding target in workflow step {index}")
            if target in arguments:
                raise ValueError(f"Binding target already has a literal argument in workflow step {index}")
            if target in seen_targets:
                raise ValueError(f"Duplicate binding target in workflow step {index}")
            if not isinstance(source_step, int) or isinstance(source_step, bool):
                raise ValueError(f"Invalid binding source step in workflow step {index}")
            if source_step < 0 or source_step >= index:
                raise ValueError(f"Bindings must reference an earlier workflow step in step {index}")
            if source_step not in depends_on:
                raise ValueError(f"Binding source must be an explicit dependency in workflow step {index}")
            _validate_source_path(source_path)
            seen_targets.add(target)
            bindings.append({
                "step_position": index,
                "target": target,
                "source_step": source_step,
                "source_path": source_path,
            })
    return goal_steps, bindings


def create_workflow(*, goal: str, steps: list[dict], request_id: str | None = None) -> dict:
    initialise()
    goal_steps, bindings = _validate_workflow_steps(steps)
    created_goal = goals.create_goal(goal=goal, steps=goal_steps, request_id=request_id)
    workflow_id = str(uuid4())
    with connection() as db:
        db.execute(
            "INSERT INTO agent_workflows (id, goal_id, plan_id) VALUES (?, ?, ?)",
            (workflow_id, created_goal["id"], created_goal["plan_id"]),
        )
        db.executemany(
            """INSERT INTO agent_workflow_bindings
               (id, workflow_id, step_position, target, source_step, source_path)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                (
                    str(uuid4()), workflow_id, binding["step_position"], binding["target"],
                    binding["source_step"], binding["source_path"],
                )
                for binding in bindings
            ],
        )
    record_audit(
        "workflow.created",
        {
            "workflow_id": workflow_id,
            "goal_id": created_goal["id"],
            "step_count": len(goal_steps),
            "binding_count": len(bindings),
            "models_used": False,
        },
        created_goal["request_id"],
    )
    return get_workflow(workflow_id) or {}


def _binding_rows_for_goal_step(goal_id: str, step_position: int) -> list[dict]:
    initialise()
    with connection() as db:
        workflow = db.execute(
            "SELECT id FROM agent_workflows WHERE goal_id = ?", (goal_id,)
        ).fetchone()
        if workflow is None:
            return []
        rows = db.execute(
            """SELECT target, source_step, source_path
               FROM agent_workflow_bindings
               WHERE workflow_id = ? AND step_position = ? ORDER BY target ASC""",
            (workflow["id"], step_position),
        ).fetchall()
    return [dict(row) for row in rows]


def _extract_scalar(payload, path: str):
    value = payload
    for part in _validate_source_path(path):
        if isinstance(value, dict):
            if part not in value:
                raise WorkflowBindingError("Verified source output does not contain the requested path")
            value = value[part]
        elif isinstance(value, list) and part.isdigit():
            index = int(part)
            if index >= len(value):
                raise WorkflowBindingError("Verified source output index is out of range")
            value = value[index]
        else:
            raise WorkflowBindingError("Verified source output path cannot be traversed")

    if isinstance(value, str):
        if len(value) > MAX_BOUND_STRING_CHARS:
            raise WorkflowBindingError("Bound string exceeds the workflow hand-off limit")
        return value
    if value is None or isinstance(value, (bool, int, float)):
        return value
    raise WorkflowBindingError("Workflow bindings may transfer scalar values only")


def _verified_result(plan_id: str, source_step: int) -> dict:
    with connection() as db:
        row = db.execute(
            """SELECT state, result, verification FROM core_executions
               WHERE plan_id = ? AND step_index = ? ORDER BY created_at DESC LIMIT 1""",
            (plan_id, source_step),
        ).fetchone()
    if row is None or str(row["state"]) != "completed":
        raise WorkflowBindingError("Workflow source step has not completed")
    try:
        verification = json.loads(row["verification"] or "null")
        result = json.loads(row["result"] or "null")
    except json.JSONDecodeError as exc:
        raise WorkflowBindingError("Stored workflow source output is invalid") from exc
    if not isinstance(verification, dict) or verification.get("ok") is not True:
        raise WorkflowBindingError("Workflow source step is not verified")
    if not isinstance(result, dict):
        raise WorkflowBindingError("Workflow source step has no usable result")
    return result


def resolve_step_arguments(goal: dict, step: dict) -> tuple[dict, int]:
    """Resolve bounded verified bindings for one goal step, or return literals unchanged."""
    bindings = _binding_rows_for_goal_step(str(goal["id"]), int(step["position"]))
    arguments = dict(step.get("arguments") or {})
    if not bindings:
        return arguments, 0

    dependency_positions = {
        int(candidate["position"])
        for candidate in goal.get("steps", [])
        if candidate.get("id") in set(step.get("depends_on") or [])
    }
    for binding in bindings:
        source_step = int(binding["source_step"])
        if source_step not in dependency_positions or source_step >= int(step["position"]):
            raise WorkflowBindingError("Stored workflow binding no longer matches the dependency graph")
        if binding["target"] in arguments:
            raise WorkflowBindingError("Stored workflow binding would overwrite a literal argument")
        source_result = _verified_result(str(goal["plan_id"]), source_step)
        arguments[str(binding["target"])] = _extract_scalar(source_result, str(binding["source_path"]))

    record_audit(
        "workflow.bindings_resolved",
        {
            "goal_id": goal["id"],
            "step_position": int(step["position"]),
            "binding_count": len(bindings),
            "values_recorded": False,
        },
        goal["request_id"],
    )
    return arguments, len(bindings)


def get_workflow(workflow_id: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute(
            "SELECT id, goal_id, plan_id, created_at FROM agent_workflows WHERE id = ?",
            (workflow_id,),
        ).fetchone()
        if row is None:
            return None
        binding_rows = db.execute(
            """SELECT step_position, target, source_step, source_path
               FROM agent_workflow_bindings WHERE workflow_id = ?
               ORDER BY step_position ASC, target ASC""",
            (workflow_id,),
        ).fetchall()
    workflow = dict(row)
    workflow["goal"] = goals.get_goal(str(row["goal_id"]))
    workflow["bindings"] = [dict(item) for item in binding_rows]
    return workflow


def status() -> dict:
    initialise()
    with connection() as db:
        workflows = int(db.execute("SELECT COUNT(*) FROM agent_workflows").fetchone()[0])
        bindings = int(db.execute("SELECT COUNT(*) FROM agent_workflow_bindings").fetchone()[0])
        source_rows = db.execute(
            """SELECT s.action AS action, COUNT(*) AS count
               FROM agent_workflows w
               JOIN agent_goal_steps s ON s.goal_id = w.goal_id
               GROUP BY s.action"""
        ).fetchall()
    tool_counts = Counter({str(row["action"]): int(row["count"]) for row in source_rows})
    return {
        "mode": WORKFLOW_MODE,
        "workflows": workflows,
        "bindings": bindings,
        "tool_kinds": len(tool_counts),
        "max_bindings_per_step": MAX_BINDINGS_PER_STEP,
        "handoff": "verified_scalar_only",
        "source_policy": "completed_and_verified_dependency_only",
        "mutation_approval": "fully_resolved_exact_scope",
        "automatic_planning": False,
        "code_evaluation": False,
        "cloud_models": False,
    }


@router.get("/v1/core/workflows/status")
async def workflow_status():
    return status()


@router.post("/v1/core/workflows")
async def create_workflow_route(request: WorkflowCreateRequest):
    try:
        return create_workflow(
            goal=request.goal,
            steps=[step.model_dump() for step in request.steps],
            request_id=request.request_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/v1/core/workflows/{workflow_id}")
async def get_workflow_route(workflow_id: str):
    item = get_workflow(workflow_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return item

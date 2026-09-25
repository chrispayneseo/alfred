"""Phase 12 durable autonomous projects.

Projects coordinate bounded sequences of already-registered Phase 11 operations.
They do not execute tools directly. Every milestone is validated through the
static operations catalog, creates an ordinary reusable-workflow goal when run,
and is therefore subject to the existing policy, exact-scope approval,
verification, retry and recovery machinery.
"""

from __future__ import annotations

import json
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import goals, operations
from .db import connection, record_audit

MODE = "autonomous_projects_v1"
MAX_MILESTONES = 8
router = APIRouter(tags=["core-autonomous-projects"])


class MilestoneRequest(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    operation_id: str = Field(min_length=1, max_length=80)
    parameters: dict = Field(default_factory=dict)


class ProjectCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    milestones: list[MilestoneRequest] = Field(min_length=1, max_length=MAX_MILESTONES)
    request_id: str | None = Field(default=None, min_length=1, max_length=64)


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS agent_projects (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            title TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('ready','active','awaiting_approval','blocked','completed','cancelled')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS agent_projects_state ON agent_projects(state, updated_at DESC)")
        db.execute("""CREATE TABLE IF NOT EXISTS agent_project_milestones (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            title TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            parameters TEXT NOT NULL,
            parameter_hash TEXT NOT NULL,
            goal_id TEXT,
            state TEXT NOT NULL CHECK(state IN ('pending','active','awaiting_approval','blocked','completed','cancelled')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(project_id, position)
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS agent_project_milestones_project ON agent_project_milestones(project_id, position)")


def _encode(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _hash(value: dict) -> str:
    import hashlib
    return hashlib.sha256(_encode(value).encode("utf-8")).hexdigest()


def create_project(*, title: str, milestones: list[dict], request_id: str | None = None) -> dict:
    initialise()
    clean_title = title.strip()
    if not clean_title or len(clean_title) > 300:
        raise ValueError("Project title is required")
    if not isinstance(milestones, list) or not 1 <= len(milestones) <= MAX_MILESTONES:
        raise ValueError(f"Project requires between 1 and {MAX_MILESTONES} milestones")

    clean: list[dict] = []
    for index, raw in enumerate(milestones):
        if not isinstance(raw, dict):
            raise ValueError(f"Invalid milestone {index}")
        milestone_title = str(raw.get("title") or "").strip()
        operation_id = str(raw.get("operation_id") or "").strip()
        parameters = raw.get("parameters")
        if not milestone_title or len(milestone_title) > 240:
            raise ValueError(f"Milestone {index} needs a title")
        if not isinstance(parameters, dict):
            raise ValueError(f"Milestone {index} parameters must be an object")
        # Preview is the static, non-mutating validation boundary for Phase 11 operations.
        operations.preview(operation_id, parameters)
        clean.append({"title": milestone_title, "operation_id": operation_id, "parameters": parameters})

    project_id = str(uuid4())
    owner_request_id = request_id or f"project:{project_id}"
    if len(owner_request_id) > 64:
        owner_request_id = owner_request_id[:64]

    rows = []
    for position, item in enumerate(clean):
        rows.append((
            str(uuid4()), project_id, position, item["title"], item["operation_id"],
            _encode(item["parameters"]), _hash(item["parameters"]), "pending",
        ))
    with connection() as db:
        db.execute(
            "INSERT INTO agent_projects(id, request_id, title, state) VALUES (?, ?, ?, 'ready')",
            (project_id, owner_request_id, clean_title),
        )
        db.executemany(
            """INSERT INTO agent_project_milestones
               (id, project_id, position, title, operation_id, parameters, parameter_hash, state)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
    record_audit(
        "project.created",
        {"project_id": project_id, "milestone_count": len(rows), "parameter_values_audited": False},
        owner_request_id,
    )
    return get_project(project_id, include_parameters=False) or {}


def _derive_milestone_state(goal_id: str | None, stored_state: str) -> str:
    if stored_state == "cancelled" or not goal_id:
        return stored_state
    goal = goals.sync_goal_progress(goal_id)
    if goal is None:
        return "blocked"
    state = str(goal.get("state"))
    if state == "completed":
        return "completed"
    if state == "awaiting_approval":
        return "awaiting_approval"
    if state in {"blocked", "cancelled"}:
        return "blocked"
    return "active"


def sync_project(project_id: str) -> dict | None:
    initialise()
    with connection() as db:
        project = db.execute("SELECT * FROM agent_projects WHERE id = ?", (project_id,)).fetchone()
        rows = db.execute(
            "SELECT id, goal_id, state FROM agent_project_milestones WHERE project_id = ? ORDER BY position",
            (project_id,),
        ).fetchall()
    if project is None:
        return None
    if project["state"] == "cancelled":
        return get_project(project_id, include_parameters=False, sync=False)

    derived: list[tuple[str, str]] = []
    for row in rows:
        derived.append((str(row["id"]), _derive_milestone_state(row["goal_id"], str(row["state"]))))
    states = [state for _, state in derived]
    if states and all(state == "completed" for state in states):
        project_state = "completed"
    elif "blocked" in states:
        project_state = "blocked"
    elif "awaiting_approval" in states:
        project_state = "awaiting_approval"
    elif any(state in {"active", "completed"} for state in states):
        project_state = "active"
    else:
        project_state = "ready"
    with connection() as db:
        db.executemany(
            "UPDATE agent_project_milestones SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [(state, milestone_id) for milestone_id, state in derived],
        )
        db.execute(
            "UPDATE agent_projects SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (project_state, project_id),
        )
    return get_project(project_id, include_parameters=False, sync=False)


def get_project(project_id: str, *, include_parameters: bool = False, sync: bool = True) -> dict | None:
    initialise()
    if sync:
        synced = sync_project(project_id)
        if synced is not None:
            return synced
    with connection() as db:
        project = db.execute("SELECT * FROM agent_projects WHERE id = ?", (project_id,)).fetchone()
        if project is None:
            return None
        rows = db.execute(
            """SELECT id, position, title, operation_id, parameters, parameter_hash, goal_id,
                      state, created_at, updated_at
               FROM agent_project_milestones WHERE project_id = ? ORDER BY position""",
            (project_id,),
        ).fetchall()
    result = dict(project)
    result["milestones"] = []
    for row in rows:
        item = dict(row)
        if include_parameters:
            item["parameters"] = json.loads(item["parameters"])
        else:
            item.pop("parameters", None)
        result["milestones"].append(item)
    return result


def list_projects(limit: int = 50) -> list[dict]:
    initialise()
    with connection() as db:
        ids = [str(row["id"]) for row in db.execute(
            "SELECT id FROM agent_projects ORDER BY updated_at DESC LIMIT ?", (max(1, min(limit, 100)),)
        ).fetchall()]
    return [item for project_id in ids if (item := sync_project(project_id)) is not None]


async def run_project(project_id: str) -> dict:
    project = get_project(project_id, include_parameters=True)
    if project is None:
        raise ValueError("Project not found")
    if project["state"] in {"completed", "cancelled"}:
        return {"project": get_project(project_id), "stop_reason": project["state"], "milestones_started": 0}

    started = 0
    stop_reason = "no_ready_milestone"
    for milestone in project["milestones"]:
        state = str(milestone["state"])
        if state == "completed":
            continue
        if state in {"active", "awaiting_approval", "blocked"}:
            stop_reason = state
            break
        if milestone.get("goal_id"):
            stop_reason = "existing_goal_requires_sync"
            break

        run = await operations.run(
            str(milestone["operation_id"]), dict(milestone["parameters"]),
            request_id=f"project:{project_id}:{milestone['position']}"[:64],
        )
        instance = ((run.get("result") or {}).get("instance") or {})
        goal_id = instance.get("goal_id")
        if not isinstance(goal_id, str) or not goal_id:
            raise RuntimeError("Project milestone did not produce a durable goal")
        run_state = str(((run.get("result") or {}).get("run") or {}).get("state") or "active")
        milestone_state = "awaiting_approval" if run_state == "awaiting_approval" else "active"
        with connection() as db:
            db.execute(
                """UPDATE agent_project_milestones
                   SET goal_id = ?, state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND goal_id IS NULL""",
                (goal_id, milestone_state, milestone["id"]),
            )
            db.execute("UPDATE agent_projects SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (milestone_state if milestone_state == "awaiting_approval" else "active", project_id))
        started += 1
        stop_reason = milestone_state
        # One new durable goal per invocation keeps project autonomy bounded and observable.
        break

    record_audit(
        "project.run",
        {"project_id": project_id, "milestones_started": started, "stop_reason": stop_reason, "bounded_new_goals": 1},
        str(project["request_id"]),
    )
    return {"project": sync_project(project_id), "stop_reason": stop_reason, "milestones_started": started}


def cancel_project(project_id: str) -> dict:
    project = get_project(project_id, include_parameters=False)
    if project is None:
        raise ValueError("Project not found")
    with connection() as db:
        db.execute("UPDATE agent_projects SET state = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (project_id,))
        db.execute("UPDATE agent_project_milestones SET state = CASE WHEN state = 'pending' THEN 'cancelled' ELSE state END, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?", (project_id,))
    record_audit("project.cancelled", {"project_id": project_id, "active_goals_cancelled": False}, str(project["request_id"]))
    return get_project(project_id, sync=False) or {}


def status() -> dict:
    initialise()
    with connection() as db:
        count = int(db.execute("SELECT COUNT(*) FROM agent_projects").fetchone()[0])
    return {
        "mode": MODE,
        "projects": count,
        "max_milestones": MAX_MILESTONES,
        "milestones_per_run": 1,
        "operation_catalog_reused": True,
        "durable_goals_reused": True,
        "bounded_agent_loop_reused": True,
        "exact_scope_approval_reused": True,
        "verification_recovery_reused": True,
        "automatic_approval": False,
        "automatic_mutation_replay": False,
        "new_executor": False,
        "cloud_models": False,
    }


@router.get("/v1/core/projects/status")
async def projects_status():
    return status()


@router.get("/v1/core/projects")
async def projects_list(limit: int = 50):
    return {"mode": MODE, "items": list_projects(limit)}


@router.post("/v1/core/projects")
async def projects_create(request: ProjectCreateRequest):
    try:
        return create_project(title=request.title, milestones=[item.model_dump() for item in request.milestones], request_id=request.request_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/v1/core/projects/{project_id}")
async def projects_get(project_id: str):
    item = get_project(project_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return item


@router.post("/v1/core/projects/{project_id}/run")
async def projects_run(project_id: str):
    try:
        return await run_project(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/v1/core/projects/{project_id}/cancel")
async def projects_cancel(project_id: str):
    try:
        return cancel_project(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

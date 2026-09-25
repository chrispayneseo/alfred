"""Deterministic reusable workflow recipes for Alfred Phase 5G.

Recipes are versioned application-code compilers. They validate bounded inputs and
emit ordinary Phase 5C workflows; they never execute tools directly, create a
second policy path, resolve approvals, call a model, or invent actions at runtime.
An explicit owner request may instantiate a recipe or instantiate-and-start it
through the existing Phase 5B bounded agent loop.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta
from urllib.parse import urlsplit
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import agent_loop, config, integrations, workflows
from .core import TOOLS
from .db import connection, record_audit


RECIPE_MODE = "reusable_workflows_v1"
RECIPE_SOURCE = "static_application_code_v1"
router = APIRouter(tags=["core-reusable-workflows"])


@dataclass(frozen=True)
class Parameter:
    name: str
    kind: str
    required: bool = True
    max_length: int | None = None
    minimum: int | None = None
    maximum: int | None = None
    default: object | None = None
    description: str = ""


@dataclass(frozen=True)
class Recipe:
    id: str
    title: str
    description: str
    version: int
    parameters: tuple[Parameter, ...]
    compiler: str


class RecipeRequest(BaseModel):
    parameters: dict = Field(default_factory=dict)
    request_id: str | None = Field(default=None, min_length=1, max_length=64)


def _browser_research_steps(url: str) -> list[dict]:
    return [
        {
            "action": "browser.session.open",
            "arguments": {"url": url},
            "depends_on": [],
            "bindings": [],
        },
        {
            "action": "browser.page.inspect",
            "arguments": {},
            "depends_on": [0],
            "bindings": [
                {"target": "session_id", "source_step": 0, "source_path": "session_id"},
            ],
        },
        {
            "action": "browser.session.close",
            "arguments": {},
            "depends_on": [0, 1],
            "bindings": [
                {"target": "session_id", "source_step": 0, "source_path": "session_id"},
            ],
        },
    ]


RECIPES: dict[str, Recipe] = {
    item.id: item
    for item in (
        Recipe(
            id="prepare_tomorrow",
            title="Prepare me for tomorrow",
            description="Review one local day of Calendar plus open local tasks.",
            version=1,
            parameters=(
                Parameter(
                    "date", "date", description="Local calendar date in YYYY-MM-DD form."
                ),
                Parameter(
                    "task_limit", "integer", required=False, default=20,
                    minimum=1, maximum=50,
                    description="Maximum number of open tasks to include.",
                ),
            ),
            compiler="prepare_tomorrow_v1",
        ),
        Recipe(
            id="deal_with_forwarded_message",
            title="Deal with forwarded message",
            description="Prepare a local follow-up task containing the forwarded message.",
            version=1,
            parameters=(
                Parameter("message", "text", max_length=4000, description="Forwarded message text."),
                Parameter(
                    "due", "optional_text", required=False, default=None, max_length=128,
                    description="Optional due value accepted by Alfred Tasks.",
                ),
            ),
            compiler="deal_with_forwarded_message_v1",
        ),
        Recipe(
            id="research_purchase",
            title="Research a purchase",
            description="Open, inspect and close a supplied public product or research page.",
            version=1,
            parameters=(
                Parameter("url", "url", max_length=2048, description="Public HTTP(S) page to inspect."),
            ),
            compiler="research_purchase_v1",
        ),
        Recipe(
            id="plan_dinner_out",
            title="Plan dinner out",
            description="Open, inspect and close a supplied public restaurant or booking page.",
            version=1,
            parameters=(
                Parameter("url", "url", max_length=2048, description="Public HTTP(S) restaurant or booking page."),
            ),
            compiler="plan_dinner_out_v1",
        ),
        Recipe(
            id="prepare_client_task",
            title="Prepare a client task",
            description="Prepare one local client task and stop at the existing task approval boundary.",
            version=1,
            parameters=(
                Parameter("title", "text", max_length=300, description="Task title."),
                Parameter(
                    "detail", "optional_text", required=False, default="", max_length=4000,
                    description="Optional task detail.",
                ),
                Parameter(
                    "due", "optional_text", required=False, default=None, max_length=128,
                    description="Optional due value accepted by Alfred Tasks.",
                ),
            ),
            compiler="prepare_client_task_v1",
        ),
    )
}


def initialise() -> None:
    with connection() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS agent_recipe_instances (
                id TEXT PRIMARY KEY,
                recipe_id TEXT NOT NULL,
                recipe_version INTEGER NOT NULL,
                workflow_id TEXT NOT NULL UNIQUE,
                goal_id TEXT NOT NULL UNIQUE,
                plan_id TEXT NOT NULL UNIQUE,
                request_id TEXT NOT NULL,
                parameter_count INTEGER NOT NULL,
                parameter_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS agent_recipe_instances_recipe "
            "ON agent_recipe_instances(recipe_id, created_at DESC)"
        )


def _canonical_hash(parameters: dict) -> str:
    encoded = json.dumps(
        parameters, sort_keys=True, separators=(",", ":"), default=str
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_url(value: object, max_length: int) -> str:
    if not isinstance(value, str):
        raise ValueError("Recipe URL must be text")
    clean = value.strip()
    if not clean or len(clean) > max_length:
        raise ValueError("Recipe URL is missing or too long")
    parsed = urlsplit(clean)
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Recipe URL must be HTTP(S)")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Recipe URLs must not contain embedded credentials")
    return clean


def _validate_parameter(definition: Parameter, value: object):
    if definition.kind in {"text", "optional_text"}:
        if value is None and definition.kind == "optional_text":
            return None
        if not isinstance(value, str):
            raise ValueError(f"Recipe parameter {definition.name} must be text")
        clean = value.strip()
        if definition.kind == "text" and not clean:
            raise ValueError(f"Recipe parameter {definition.name} cannot be empty")
        if definition.max_length is not None and len(clean) > definition.max_length:
            raise ValueError(f"Recipe parameter {definition.name} is too long")
        return clean
    if definition.kind == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(f"Recipe parameter {definition.name} must be an integer")
        if definition.minimum is not None and value < definition.minimum:
            raise ValueError(f"Recipe parameter {definition.name} is below its minimum")
        if definition.maximum is not None and value > definition.maximum:
            raise ValueError(f"Recipe parameter {definition.name} exceeds its maximum")
        return value
    if definition.kind == "date":
        if not isinstance(value, str):
            raise ValueError(f"Recipe parameter {definition.name} must be YYYY-MM-DD")
        try:
            parsed = date.fromisoformat(value.strip())
        except ValueError as exc:
            raise ValueError(
                f"Recipe parameter {definition.name} must be YYYY-MM-DD"
            ) from exc
        return parsed.isoformat()
    if definition.kind == "url":
        return _validate_url(value, definition.max_length or 2048)
    raise ValueError(f"Unsupported recipe parameter type: {definition.kind}")


def validate_parameters(recipe: Recipe, parameters: dict) -> dict:
    if not isinstance(parameters, dict):
        raise ValueError("Recipe parameters must be an object")
    definitions = {item.name: item for item in recipe.parameters}
    unexpected = set(parameters) - set(definitions)
    if unexpected:
        raise ValueError(f"Unexpected recipe parameter: {sorted(unexpected)[0]}")

    clean: dict = {}
    for name, definition in definitions.items():
        if name in parameters:
            value = parameters[name]
        elif definition.required:
            raise ValueError(f"Missing recipe parameter: {name}")
        else:
            value = definition.default
        clean[name] = _validate_parameter(definition, value)
    return clean


def _day_window(local_date: str) -> tuple[str, str]:
    target = date.fromisoformat(local_date)
    try:
        timezone = ZoneInfo(config.settings.timezone)
    except Exception as exc:
        raise ValueError("Configured Alfred timezone is invalid") from exc
    start = datetime.combine(target, time.min, timezone)
    end = datetime.combine(target + timedelta(days=1), time.min, timezone)
    return start.isoformat(), end.isoformat()


def compile_recipe(recipe: Recipe, parameters: dict) -> tuple[str, list[dict]]:
    params = validate_parameters(recipe, parameters)

    if recipe.compiler == "prepare_tomorrow_v1":
        start, end = _day_window(params["date"])
        return (
            f"Prepare for {params['date']}",
            [
                {
                    "action": "calendar.events.list",
                    "arguments": {"start": start, "end": end, "limit": 20},
                    "depends_on": [],
                    "bindings": [],
                },
                {
                    "action": "tasks.list",
                    "arguments": {
                        "include_completed": False,
                        "limit": params["task_limit"],
                    },
                    "depends_on": [],
                    "bindings": [],
                },
            ],
        )

    if recipe.compiler == "deal_with_forwarded_message_v1":
        return (
            "Deal with a forwarded message",
            [
                {
                    "action": "tasks.create",
                    "arguments": {
                        "kind": "task",
                        "title": "Follow up forwarded message",
                        "due": params["due"],
                        "detail": params["message"],
                    },
                    "depends_on": [],
                    "bindings": [],
                }
            ],
        )

    if recipe.compiler == "research_purchase_v1":
        host = urlsplit(params["url"]).hostname or "public page"
        return f"Research a purchase on {host}", _browser_research_steps(params["url"])

    if recipe.compiler == "plan_dinner_out_v1":
        host = urlsplit(params["url"]).hostname or "public page"
        return f"Plan dinner out using {host}", _browser_research_steps(params["url"])

    if recipe.compiler == "prepare_client_task_v1":
        return (
            "Prepare a client task",
            [
                {
                    "action": "tasks.create",
                    "arguments": {
                        "kind": "task",
                        "title": params["title"],
                        "due": params["due"],
                        "detail": params["detail"],
                    },
                    "depends_on": [],
                    "bindings": [],
                }
            ],
        )

    raise ValueError("Recipe compiler is not registered")


def _required_actions(steps: list[dict]) -> list[str]:
    actions: list[str] = []
    for step in steps:
        action = step.get("action")
        if not isinstance(action, str) or action not in TOOLS:
            raise ValueError("Recipe compiled an unregistered action")
        if action not in actions:
            actions.append(action)
    return actions


def _check_availability(actions: list[str]) -> None:
    for action in actions:
        available, reason = integrations.action_available(action)
        if not available:
            raise ValueError(reason or f"Recipe capability is unavailable: {action}")


def _catalog_item(recipe: Recipe) -> dict:
    parameters = [asdict(item) for item in recipe.parameters]
    _, sample_steps = compile_recipe(
        recipe,
        {
            item.name: (
                item.default
                if not item.required
                else "2026-01-01"
                if item.kind == "date"
                else "https://example.com"
                if item.kind == "url"
                else "example"
            )
            for item in recipe.parameters
        },
    )
    actions = _required_actions(sample_steps)
    unavailable = [
        action for action in actions if not integrations.action_available(action)[0]
    ]
    return {
        "id": recipe.id,
        "title": recipe.title,
        "description": recipe.description,
        "version": recipe.version,
        "parameters": parameters,
        "actions": actions,
        "available": not unavailable,
        "unavailable_actions": unavailable,
        "automatic_start": False,
    }


def catalog() -> list[dict]:
    return [_catalog_item(RECIPES[key]) for key in sorted(RECIPES)]


def instantiate_recipe(
    recipe_id: str, *, parameters: dict, request_id: str | None = None
) -> dict:
    initialise()
    recipe = RECIPES.get(recipe_id)
    if recipe is None:
        raise ValueError("Unknown reusable workflow recipe")
    clean_parameters = validate_parameters(recipe, parameters)
    goal_text, steps = compile_recipe(recipe, clean_parameters)
    actions = _required_actions(steps)
    _check_availability(actions)

    instance_id = str(uuid4())
    owner_request_id = request_id or f"recipe:{instance_id}"
    if not isinstance(owner_request_id, str) or not 1 <= len(owner_request_id) <= 64:
        raise ValueError("Invalid request id")

    workflow = workflows.create_workflow(
        goal=goal_text,
        steps=steps,
        request_id=owner_request_id,
    )
    goal = workflow.get("goal") or {}
    if not all(isinstance(goal.get(key), str) for key in ("id", "plan_id", "request_id")):
        raise RuntimeError("Reusable workflow did not produce a durable goal")

    with connection() as db:
        db.execute(
            """INSERT INTO agent_recipe_instances
               (id, recipe_id, recipe_version, workflow_id, goal_id, plan_id,
                request_id, parameter_count, parameter_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                instance_id,
                recipe.id,
                recipe.version,
                workflow["id"],
                goal["id"],
                goal["plan_id"],
                goal["request_id"],
                len(clean_parameters),
                _canonical_hash(clean_parameters),
            ),
        )

    record_audit(
        "recipe.instantiated",
        {
            "instance_id": instance_id,
            "recipe_id": recipe.id,
            "recipe_version": recipe.version,
            "workflow_id": workflow["id"],
            "goal_id": goal["id"],
            "step_count": len(steps),
            "parameter_count": len(clean_parameters),
            "parameter_values_recorded": False,
            "automatic_start": False,
            "models_used": False,
        },
        goal["request_id"],
    )
    return get_instance(instance_id) or {}


def get_instance(instance_id: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute(
            """SELECT id, recipe_id, recipe_version, workflow_id, goal_id, plan_id,
                      request_id, parameter_count, parameter_hash, created_at
               FROM agent_recipe_instances WHERE id = ?""",
            (instance_id,),
        ).fetchone()
    if row is None:
        return None
    item = dict(row)
    item["workflow"] = workflows.get_workflow(str(row["workflow_id"]))
    return item


async def run_recipe(
    recipe_id: str, *, parameters: dict, request_id: str | None = None
) -> dict:
    instance = instantiate_recipe(
        recipe_id, parameters=parameters, request_id=request_id
    )
    goal_id = str(instance["goal_id"])
    record_audit(
        "recipe.run_requested",
        {
            "instance_id": instance["id"],
            "recipe_id": recipe_id,
            "goal_id": goal_id,
            "execution_path": "existing_bounded_agent_loop",
        },
        str(instance["request_id"]),
    )
    run = await agent_loop.run_goal(goal_id, trigger="recipe_owner")
    return {
        "instance": instance,
        "run": run,
        "execution_path": "existing_bounded_agent_loop",
        "automatic_start": False,
    }


def status() -> dict:
    initialise()
    with connection() as db:
        instances = int(
            db.execute("SELECT COUNT(*) FROM agent_recipe_instances").fetchone()[0]
        )
    return {
        "mode": RECIPE_MODE,
        "recipes": len(RECIPES),
        "instances": instances,
        "definition_source": RECIPE_SOURCE,
        "compiler": "deterministic_static_recipe_compiler",
        "creates": "existing_phase5c_workflow_and_phase5a_goal",
        "executor": "existing_phase5b_bounded_agent_loop",
        "approval_policy": "existing_exact_scope",
        "verification_recovery": "existing_phase5e",
        "browser_policy": "existing_phase5f",
        "automatic_start": False,
        "runtime_action_invention": False,
        "code_evaluation": False,
        "parameter_values_in_status": False,
        "cloud_models": False,
    }


@router.get("/v1/core/recipes/status")
async def recipe_status():
    return status()


@router.get("/v1/core/recipes")
async def recipe_catalog():
    return {"items": catalog()}


@router.post("/v1/core/recipes/{recipe_id}/instantiate")
async def instantiate_recipe_route(recipe_id: str, request: RecipeRequest):
    try:
        return instantiate_recipe(
            recipe_id,
            parameters=request.parameters,
            request_id=request.request_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/v1/core/recipes/{recipe_id}/run")
async def run_recipe_route(recipe_id: str, request: RecipeRequest):
    try:
        return await run_recipe(
            recipe_id,
            parameters=request.parameters,
            request_id=request.request_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/v1/core/recipes/instances/{instance_id}")
async def get_recipe_instance_route(instance_id: str):
    item = get_instance(instance_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Recipe instance not found")
    return item

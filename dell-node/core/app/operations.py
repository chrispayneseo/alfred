"""Phase 11 first-party life and work operations.

Operations are friendly, static aliases over Alfred's already-accepted reusable
workflow recipes. They never define runtime tool names, bypass availability or
policy checks, or execute outside the Phase 5 bounded goal/approval machinery.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import reusable_workflows

MODE = "life_work_operations_v1"
router = APIRouter(tags=["core-life-work-operations"])


@dataclass(frozen=True)
class Operation:
    id: str
    title: str
    domain: str
    description: str
    recipe_id: str


OPERATIONS: dict[str, Operation] = {
    item.id: item for item in (
        Operation("prepare_tomorrow", "Prepare tomorrow", "personal_admin", "Review tomorrow's calendar and open local tasks.", "prepare_tomorrow"),
        Operation("follow_up_forward", "Follow up a forwarded message", "personal_admin", "Turn reviewed forwarded content into a guarded local follow-up task.", "deal_with_forwarded_message"),
        Operation("research_purchase", "Research a purchase", "shopping_research", "Inspect a supplied public product/research page without purchasing.", "research_purchase"),
        Operation("plan_dinner_out", "Plan dinner out", "leisure", "Inspect a supplied public restaurant/booking page without booking.", "plan_dinner_out"),
        Operation("prepare_client_task", "Prepare a client task", "work", "Create a guarded local client task through the existing approval boundary.", "prepare_client_task"),
        Operation("prepare_home_task", "Prepare a home/admin task", "home_admin", "Create a guarded local household/admin task using the existing task recipe.", "prepare_client_task"),
    )
}


class OperationRequest(BaseModel):
    parameters: dict = Field(default_factory=dict)
    request_id: str | None = Field(default=None, min_length=1, max_length=64)


def _operation(operation_id: str) -> Operation:
    item = OPERATIONS.get(operation_id)
    if item is None:
        raise ValueError("Unknown Alfred operation")
    if item.recipe_id not in reusable_workflows.RECIPES:
        raise RuntimeError("Operation recipe is not registered")
    return item


def _catalog_item(item: Operation) -> dict:
    recipe = reusable_workflows.RECIPES[item.recipe_id]
    recipe_item = next(row for row in reusable_workflows.catalog() if row["id"] == item.recipe_id)
    return {
        "id": item.id,
        "title": item.title,
        "domain": item.domain,
        "description": item.description,
        "recipe_id": item.recipe_id,
        "recipe_version": recipe.version,
        "parameters": recipe_item["parameters"],
        "actions": recipe_item["actions"],
        "available": recipe_item["available"],
        "automatic_start": False,
        "execution_path": "existing_reusable_workflow_and_agent_loop",
    }


def catalog() -> list[dict]:
    return [_catalog_item(OPERATIONS[key]) for key in sorted(OPERATIONS)]


def preview(operation_id: str, parameters: dict) -> dict:
    operation = _operation(operation_id)
    recipe = reusable_workflows.RECIPES[operation.recipe_id]
    clean = reusable_workflows.validate_parameters(recipe, parameters)
    goal, steps = reusable_workflows.compile_recipe(recipe, clean)
    actions = [str(step["action"]) for step in steps]
    return {
        "mode": MODE,
        "operation": _catalog_item(operation),
        "goal": goal,
        "step_count": len(steps),
        "actions": actions,
        "parameter_values_returned": False,
        "will_start": False,
        "will_mutate": False,
        "approval_boundaries_preserved": True,
    }


async def run(operation_id: str, parameters: dict, request_id: str | None = None) -> dict:
    operation = _operation(operation_id)
    result = await reusable_workflows.run_recipe(
        operation.recipe_id, parameters=parameters, request_id=request_id
    )
    return {
        "mode": MODE,
        "operation_id": operation.id,
        "recipe_id": operation.recipe_id,
        "execution_path": result.get("execution_path"),
        "automatic_start": False,
        "approval_boundaries_preserved": True,
        "result": result,
    }


def status() -> dict:
    return {
        "mode": MODE,
        "operation_count": len(OPERATIONS),
        "domains": sorted({item.domain for item in OPERATIONS.values()}),
        "definition_source": "static_application_code",
        "runtime_tool_definition": False,
        "creates_new_executor": False,
        "recipe_compiler_reused": True,
        "bounded_agent_loop_reused": True,
        "exact_scope_approval_reused": True,
        "browser_purchase_submission": False,
        "email_send": False,
        "cloud_models": False,
    }


@router.get("/v1/core/operations/status")
async def operations_status():
    return status()


@router.get("/v1/core/operations/catalog")
async def operations_catalog():
    return {"mode": MODE, "items": catalog()}


@router.post("/v1/core/operations/{operation_id}/preview")
async def operations_preview(operation_id: str, request: OperationRequest):
    try:
        return preview(operation_id, request.parameters)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/v1/core/operations/{operation_id}/run")
async def operations_run(operation_id: str, request: OperationRequest):
    try:
        return await run(operation_id, request.parameters, request.request_id)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

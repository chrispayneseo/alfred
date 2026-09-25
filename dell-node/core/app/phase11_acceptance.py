"""Phase 11 life/work operations acceptance contract."""

from __future__ import annotations

from fastapi import APIRouter

from . import operations, phase10_acceptance, reusable_workflows

MODE = "phase11_life_work_operations_acceptance_v1"
router = APIRouter(tags=["core-phase11-acceptance"])


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def acceptance_status() -> dict:
    phase10 = phase10_acceptance.acceptance_status()
    status = operations.status()
    operation_recipes = {item.recipe_id for item in operations.OPERATIONS.values()}
    checks = [
        _check("phase10_baseline_preserved", phase10.get("accepted") is True, "Phase 11 layers on the accepted Phase 10 contract."),
        _check("static_operation_catalog", status.get("definition_source") == "static_application_code" and status.get("operation_count", 0) >= 5, "Operations are reviewed application-code definitions."),
        _check("registered_recipes_only", operation_recipes.issubset(reusable_workflows.RECIPES), "Every operation compiles through an existing registered reusable recipe."),
        _check("no_runtime_tools", status.get("runtime_tool_definition") is False, "Operation inputs cannot define tool/action names at runtime."),
        _check("existing_recipe_compiler", status.get("recipe_compiler_reused") is True, "Phase 11 reuses deterministic recipe validation and compilation."),
        _check("existing_agent_loop", status.get("bounded_agent_loop_reused") is True and status.get("creates_new_executor") is False, "Operations run through the accepted bounded agent loop."),
        _check("approval_boundary_reused", status.get("exact_scope_approval_reused") is True, "Writes still stop at existing exact-scope approval."),
        _check("no_purchase_submission", status.get("browser_purchase_submission") is False, "Research and restaurant operations cannot submit purchases/bookings automatically."),
        _check("no_email_send", status.get("email_send") is False, "Operations do not introduce email sending."),
        _check("cloud_independent_catalog", status.get("cloud_models") is False, "Catalog, preview and compilation require no cloud model."),
    ]
    return {
        "mode": MODE,
        "accepted": all(item["passed"] for item in checks),
        "check_count": len(checks),
        "failed_checks": [item["name"] for item in checks if not item["passed"]],
        "checks": checks,
        "phase10_mode": phase10.get("mode"),
        "operations_mode": status.get("mode"),
        "new_executor": False,
        "runtime_tool_definition": False,
        "automatic_purchase_or_booking": False,
        "adversarial_suite": "phase11_test_and_live_smoke_required",
    }


@router.get("/v1/core/phase11/status")
async def phase11_status():
    return acceptance_status()

"""Phase 12 autonomous-project acceptance contract."""

from __future__ import annotations

from fastapi import APIRouter

from . import phase11_acceptance, projects

MODE = "phase12_autonomous_projects_acceptance_v1"
router = APIRouter(tags=["core-phase12-acceptance"])


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def acceptance_status() -> dict:
    previous = phase11_acceptance.acceptance_status()
    status = projects.status()
    checks = [
        _check("phase11_baseline_preserved", previous.get("accepted") is True, "Phase 12 layers on the accepted Phase 11 contract."),
        _check("bounded_projects", status.get("max_milestones") == 8 and status.get("milestones_per_run") == 1, "Projects are bounded and create at most one new milestone goal per invocation."),
        _check("operation_catalog_reused", status.get("operation_catalog_reused") is True, "Milestones use registered Phase 11 operations only."),
        _check("durable_goals_reused", status.get("durable_goals_reused") is True, "Every runnable milestone becomes an ordinary durable Alfred goal."),
        _check("bounded_agent_loop_reused", status.get("bounded_agent_loop_reused") is True and status.get("new_executor") is False, "Project execution reuses the accepted bounded agent loop."),
        _check("approval_boundary_reused", status.get("exact_scope_approval_reused") is True and status.get("automatic_approval") is False, "Projects cannot approve their own consequential actions."),
        _check("verification_recovery_reused", status.get("verification_recovery_reused") is True, "Milestones inherit existing verification/recovery semantics."),
        _check("no_mutation_replay", status.get("automatic_mutation_replay") is False, "Projects do not replay ambiguous mutations."),
        _check("no_parallel_executor", status.get("new_executor") is False, "Phase 12 adds coordination, not a second executor."),
        _check("cloud_independent_coordination", status.get("cloud_models") is False, "Project coordination is deterministic and local."),
    ]
    return {
        "mode": MODE,
        "accepted": all(item["passed"] for item in checks),
        "check_count": len(checks),
        "failed_checks": [item["name"] for item in checks if not item["passed"]],
        "checks": checks,
        "phase11_mode": previous.get("mode"),
        "projects_mode": status.get("mode"),
        "new_executor": False,
        "automatic_approval": False,
        "automatic_mutation_replay": False,
        "adversarial_suite": "phase12_test_and_live_smoke_required",
    }


@router.get("/v1/core/phase12/status")
async def phase12_status():
    return acceptance_status()

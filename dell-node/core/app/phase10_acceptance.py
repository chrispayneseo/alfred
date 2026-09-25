"""Phase 10 proactive-intelligence acceptance contract."""

from __future__ import annotations

from fastapi import APIRouter

from . import phase9_acceptance, proactive_intelligence

MODE = "phase10_proactive_intelligence_acceptance_v1"
router = APIRouter(tags=["core-phase10-acceptance"])


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def acceptance_status() -> dict:
    phase9 = phase9_acceptance.acceptance_status()
    status = proactive_intelligence.status()
    checks = [
        _check("phase9_baseline_preserved", phase9.get("accepted") is True, "Phase 10 layers on the accepted Phase 9 contract."),
        _check("deadline_detection", status.get("deadline_detection") is True, "Overdue and due-today local commitments can be detected deterministically."),
        _check("approval_detection", status.get("approval_detection") is True, "Waiting exact-scope approvals are surfaced as attention, not bypassed."),
        _check("execution_problem_detection", status.get("execution_problem_detection") is True, "Reconciliation and terminal execution problems can be surfaced."),
        _check("knowledge_review_detection", status.get("knowledge_conflict_detection") is True and status.get("stale_knowledge_detection") is True, "Knowledge conflicts and stale-review candidates can be surfaced."),
        _check("event_driven_delivery", status.get("delivery") == "in_app_event_driven", "Interventions are event-driven in-app items rather than an automatic briefing."),
        _check("no_daily_briefing", status.get("daily_briefing") is False, "Phase 10 does not opt the owner into a daily briefing."),
        _check("no_unsolicited_cloud", status.get("unsolicited_cloud_reasoning") is False and status.get("cloud_models") is False, "Signal detection is local and deterministic."),
        _check("no_automatic_external_action", status.get("automatic_external_action") is False, "Detection never becomes an automatic external mutation."),
        _check("no_new_executor", status.get("new_executor") is False, "Phase 10 adds no executor or alternate approval path."),
    ]
    return {
        "mode": MODE,
        "accepted": all(item["passed"] for item in checks),
        "check_count": len(checks),
        "failed_checks": [item["name"] for item in checks if not item["passed"]],
        "checks": checks,
        "phase9_mode": phase9.get("mode"),
        "intelligence_mode": status.get("mode"),
        "new_executor": False,
        "cloud_models": False,
        "automatic_external_action": False,
        "adversarial_suite": "phase10_test_and_live_smoke_required",
    }


@router.get("/v1/core/phase10/status")
async def phase10_status():
    return acceptance_status()

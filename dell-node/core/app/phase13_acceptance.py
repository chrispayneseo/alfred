"""Phase 13 specialist-orchestration acceptance contract."""

from __future__ import annotations

from fastapi import APIRouter

from . import phase12_acceptance, specialist_orchestration

MODE = "phase13_specialist_orchestration_acceptance_v1"
router = APIRouter(tags=["core-phase13-acceptance"])


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def acceptance_status() -> dict:
    previous = phase12_acceptance.acceptance_status()
    status = specialist_orchestration.status()
    checks = [
        _check("phase12_baseline_preserved", previous.get("accepted") is True, "Phase 13 layers on the accepted Phase 12 contract."),
        _check("planning_only_surface", status.get("planning_only") is True and status.get("provider_calls") is False, "Specialist plan/status routes never execute providers."),
        _check("bounded_cloud_prompt", status.get("max_cloud_prompt_chars") == 12000, "Cloud prompt size has an explicit Core-owned upper bound."),
        _check("bounded_connected_context", status.get("max_connected_context_chars") == 6000, "Connected context has a separate explicit budget."),
        _check("bounded_fallback_policy", status.get("max_fallbacks") == 1 and status.get("fallback_is_automatic") is False, "Fallback planning is bounded and a provider failure is not silently replayed to another provider."),
        _check("memory_not_auto_sent", status.get("memory_automatically_sent") is False, "Durable memory is never automatically attached to cloud prompts."),
        _check("connected_data_not_auto_sent", status.get("connected_data_automatically_sent") is False, "Connected account data is not automatically forwarded to a specialist."),
        _check("existing_privacy_gate_reused", status.get("existing_cloud_privacy_gate_reused") is True, "Existing exact cloud-transfer privacy approval remains authoritative."),
        _check("existing_provider_execution_reused", status.get("existing_provider_execution_reused") is True and status.get("new_executor") is False, "Cloud execution remains in the existing provider boundary."),
        _check("no_runtime_provider_definition", status.get("runtime_provider_definition") is False, "Prompts/models cannot register providers at runtime."),
    ]
    return {
        "mode": MODE,
        "accepted": all(item["passed"] for item in checks),
        "check_count": len(checks),
        "failed_checks": [item["name"] for item in checks if not item["passed"]],
        "checks": checks,
        "phase12_mode": previous.get("mode"),
        "specialist_mode": status.get("mode"),
        "new_executor": False,
        "provider_calls": False,
        "automatic_fallback": False,
        "adversarial_suite": "phase13_test_and_live_smoke_required",
    }


@router.get("/v1/core/phase13/status")
async def phase13_status():
    return acceptance_status()

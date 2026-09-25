"""Phase 9 deep-memory acceptance contract."""

from __future__ import annotations

from fastapi import APIRouter

from . import knowledge, phase8_acceptance

MODE = "phase9_deep_memory_acceptance_v1"
router = APIRouter(tags=["core-phase9-acceptance"])


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def acceptance_status() -> dict:
    phase8 = phase8_acceptance.acceptance_status()
    status = knowledge.status()
    checks = [
        _check("phase8_baseline_preserved", phase8.get("accepted") is True, "Phase 9 layers on the accepted Phase 8 contract."),
        _check("approved_memory_only", status.get("content_policy") == "approved_local_memory_only", "Knowledge is derived from approved durable local memory and local task context."),
        _check("provenance_preserved", status.get("provenance_preserved") is True, "Every knowledge result retains local provenance."),
        _check("confidence_preserved", status.get("confidence_preserved") is True, "Knowledge results retain deterministic memory confidence."),
        _check("supersession_preserved", status.get("supersession_preserved") is True, "Superseded facts remain auditable but inactive."),
        _check("contradictions_require_review", status.get("contradictions_require_owner_review") is True, "Conflicting claims are surfaced rather than silently reconciled."),
        _check("no_connected_shadow_index", status.get("connected_payload_indexed") is False, "Gmail/Calendar payloads are not copied into a durable shadow knowledge index."),
        _check("no_transient_chat_index", status.get("transient_conversation_indexed") is False, "TTL conversation turns do not become knowledge automatically."),
        _check("no_model_auto_memory", status.get("model_auto_memory") is False, "Model output cannot silently become durable personal knowledge."),
        _check("no_new_executor", status.get("new_executor") is False and status.get("cloud_models") is False, "Phase 9 is local/read-only and adds no execution path or cloud dependency."),
    ]
    return {
        "mode": MODE,
        "accepted": all(item["passed"] for item in checks),
        "check_count": len(checks),
        "failed_checks": [item["name"] for item in checks if not item["passed"]],
        "checks": checks,
        "phase8_mode": phase8.get("mode"),
        "knowledge_mode": status.get("mode"),
        "new_executor": False,
        "cloud_models": False,
        "mutations": False,
        "adversarial_suite": "phase9_test_and_live_smoke_required",
    }


@router.get("/v1/core/phase9/status")
async def phase9_status():
    return acceptance_status()

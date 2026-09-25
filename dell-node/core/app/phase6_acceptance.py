"""Phase 6 daily-utility acceptance contract.

This endpoint is read-only. It verifies that the daily-utility layer is additive
and still depends on the accepted Phase 5 safety boundary for execution.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import daily_operations, hardening_acceptance


MODE = "phase6_daily_utility_acceptance_v1"
router = APIRouter(tags=["core-phase6-acceptance"])


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def acceptance_status() -> dict:
    phase5 = hardening_acceptance.acceptance_status()
    daily = daily_operations.status()
    checks = [
        _check(
            "phase5_baseline_preserved",
            phase5.get("accepted") is True and daily.get("phase5_accepted") is True,
            "Phase 6 is layered on the fully accepted Phase 5 baseline.",
        ),
        _check(
            "reviewed_capture_contract",
            daily.get("capture_mode") == "reviewed_capture_v1"
            and daily.get("raw_forwarded_text_as_instruction") is False,
            "Forwarded text remains untrusted data and only reviewed fields can be dispatched.",
        ),
        _check(
            "guarded_dispatch_contract",
            daily.get("dispatch_mode") == "phase5_guarded_dispatch_v1"
            and daily.get("exact_scope_core_approval") is True,
            "Phase 6 dispatch delegates to the existing exact-scope Core approval path.",
        ),
        _check(
            "owner_review_required",
            daily.get("owner_review_before_dispatch") is True,
            "A reviewed interpretation is required before a captured action can be proposed.",
        ),
        _check(
            "no_parallel_executor",
            daily.get("new_executor") is False and daily.get("new_policy_path") is False,
            "Phase 6 adds no executor or alternate policy path.",
        ),
        _check(
            "no_automatic_external_mutation",
            daily.get("automatic_external_mutation") is False,
            "Daily utility never turns captured content directly into an automatic external mutation.",
        ),
        _check(
            "browser_boundary_unchanged",
            daily.get("browser_submit_enabled_by_phase6") is False,
            "Phase 6 does not enable browser submission.",
        ),
        _check(
            "email_boundary_unchanged",
            daily.get("email_send_enabled_by_phase6") is False,
            "Phase 6 does not add email sending.",
        ),
        _check(
            "command_centre_content_minimised",
            daily.get("content_policy") == "owner_reviewed_titles_only",
            "The command centre exposes reviewed titles and metadata, not raw forwarded bodies.",
        ),
        _check(
            "cloud_independent_control_plane",
            daily.get("cloud_models") is False,
            "Capture review state, dispatch policy and the daily control plane require no cloud model.",
        ),
    ]
    accepted = all(item["passed"] for item in checks)
    return {
        "mode": MODE,
        "accepted": accepted,
        "check_count": len(checks),
        "failed_checks": [item["name"] for item in checks if not item["passed"]],
        "checks": checks,
        "phase5_mode": phase5.get("mode"),
        "daily_mode": daily.get("mode"),
        "adversarial_suite": "phase6_test_and_live_smoke_required",
        "content_policy": "metadata_and_owner_reviewed_titles",
        "raw_forwarded_body_exposed": False,
        "executor_hooks_added": False,
        "policy_changes": False,
        "mutations": False,
        "cloud_models": False,
    }


@router.get("/v1/core/phase6/status")
async def phase6_status():
    return acceptance_status()

"""Phase 7 personal-agent experience acceptance contract.

Read-only acceptance checks verify that the phone/Mac experience remains an
additive surface over the accepted Phase 6 + Phase 5 boundaries.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import experience, phase6_acceptance


MODE = "phase7_personal_agent_experience_acceptance_v1"
router = APIRouter(tags=["core-phase7-acceptance"])


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def acceptance_status() -> dict:
    phase6 = phase6_acceptance.acceptance_status()
    state = experience.status()
    checks = [
        _check(
            "phase6_baseline_preserved",
            phase6.get("accepted") is True and state.get("phase6_accepted") is True,
            "Phase 7 is layered on the accepted Phase 6 daily-utility baseline.",
        ),
        _check(
            "same_authoritative_core",
            state.get("authoritative_core") is True
            and state.get("command_mode") == "authoritative_core_command_v1",
            "Phone and Mac commands still converge on the existing authoritative Core orchestrator.",
        ),
        _check(
            "agent_inbox_is_derived",
            state.get("inbox_mode") == "agent_inbox_v1"
            and state.get("new_executor") is False,
            "The Alfred Inbox is derived from durable Phase 5/6 metadata and creates no executor.",
        ),
        _check(
            "personal_search_is_local_first",
            state.get("search_mode") == "personal_search_local_first_v1"
            and state.get("local_search_cloud_models") is False,
            "Personal search stays on the Dell unless the owner explicitly uses the command path for connected/cloud work.",
        ),
        _check(
            "connected_context_reuses_core",
            state.get("connected_reads_via_existing_core") is True,
            "Connected Gmail/Calendar reads continue through the existing Core integration planning path.",
        ),
        _check(
            "event_driven_attention_only",
            state.get("notification_mode") == "event_driven_attention_v1"
            and state.get("daily_briefing") is False,
            "Phase 7 surfaces event-driven attention without introducing automatic daily briefings.",
        ),
        _check(
            "reviewed_capture_reused",
            state.get("owner_reviewed_capture_reused") is True
            and state.get("exact_scope_approval_reused") is True,
            "Capture and consequential actions retain owner review and exact-scope approval.",
        ),
        _check(
            "no_parallel_policy_or_executor",
            state.get("new_executor") is False and state.get("new_policy_path") is False,
            "Phase 7 adds no second executor or alternate policy boundary.",
        ),
        _check(
            "no_automatic_external_mutation",
            state.get("automatic_external_mutation") is False,
            "The experience layer never converts attention/search content into an automatic external mutation.",
        ),
        _check(
            "phase5_external_boundaries_unchanged",
            state.get("browser_submit_enabled_by_phase7") is False
            and state.get("email_send_enabled_by_phase7") is False,
            "Phase 7 does not enable browser submission or email sending.",
        ),
        _check(
            "supported_surfaces_are_phone_and_mac",
            state.get("surfaces") == ["phone_web", "mac_web"],
            "Phase 7 is intentionally limited to the existing phone and Mac Alfred surfaces.",
        ),
    ]
    return {
        "mode": MODE,
        "accepted": all(item["passed"] for item in checks),
        "check_count": len(checks),
        "failed_checks": [item["name"] for item in checks if not item["passed"]],
        "checks": checks,
        "phase6_mode": phase6.get("mode"),
        "experience_mode": state.get("mode"),
        "adversarial_suite": "phase7_test_and_live_smoke_required",
        "executor_hooks_added": False,
        "policy_changes": False,
        "automatic_external_mutations": False,
        "surfaces": state.get("surfaces"),
    }


@router.get("/v1/core/phase7/status")
async def phase7_status():
    return acceptance_status()

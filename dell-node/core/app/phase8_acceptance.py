"""Phase 8 secure-authenticated-web acceptance contract."""

from __future__ import annotations

from fastapi import APIRouter

from . import authenticated_web, browser_actions, core, execution, phase7_acceptance

MODE = "phase8_secure_authenticated_web_acceptance_v1"
router = APIRouter(tags=["core-phase8-acceptance"])


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def acceptance_status() -> dict:
    phase7 = phase7_acceptance.acceptance_status()
    auth = authenticated_web.status()
    browser = browser_actions.status()
    decision = execution.decide(authenticated_web.AUTH_OPEN_ACTION)
    checks = [
        _check(
            "phase7_baseline_preserved",
            phase7.get("accepted") is True,
            "Phase 8 is layered on the accepted Phase 7 repository contract.",
        ),
        _check(
            "authenticated_open_registered",
            authenticated_web.AUTH_OPEN_ACTION in core.TOOLS
            and authenticated_web.AUTH_OPEN_ACTION in authenticated_web.browser_client.BROWSER_ACTIONS,
            "Authenticated session opening is a registered Core/browser action.",
        ),
        _check(
            "authenticated_open_is_read_only",
            decision.level == "read" and decision.decision == "auto",
            "Opening a human-bootstrapped profile is read-only and cannot submit an external action.",
        ),
        _check(
            "human_secret_handoff",
            auth.get("profile_bootstrap") == "human_only"
            and auth.get("profile_reference_in_core") == "opaque_id_only",
            "The owner handles login secrets; Core receives only an opaque profile reference.",
        ),
        _check(
            "credential_values_blocked",
            auth.get("password_entry_by_alfred") is False
            and auth.get("otp_entry_by_alfred") is False,
            "Alfred cannot enter passwords, passcodes or OTP/2FA values.",
        ),
        _check(
            "payment_and_captcha_blocked",
            auth.get("payment_card_entry") is False and auth.get("captcha_solving") is False,
            "Payment-card/CVV entry and CAPTCHA solving remain outside Alfred's action surface.",
        ),
        _check(
            "consequential_submit_still_guarded",
            auth.get("consequential_submit_action") == "browser.submit"
            and auth.get("consequential_submit_policy") == "phase5_exact_scope_owner_approval"
            and browser.get("submission_policy") == "exact_scope_owner_approval",
            "Authenticated flows reuse the existing exact-scope submit approval path.",
        ),
        _check(
            "browser_data_boundaries_preserved",
            auth.get("downloads") is False and auth.get("file_uploads") is False,
            "Phase 8 does not enable browser downloads or file uploads.",
        ),
        _check(
            "no_parallel_executor",
            auth.get("new_executor") is False
            and bool(getattr(execution, "_phase8_authenticated_web_enabled", False)),
            "Phase 8 extends the existing executor rather than creating a parallel execution path.",
        ),
        _check(
            "cloud_independent_control_plane",
            auth.get("cloud_models") is False,
            "Authenticated browser policy and profile selection require no cloud model.",
        ),
    ]
    return {
        "mode": MODE,
        "accepted": all(item["passed"] for item in checks),
        "check_count": len(checks),
        "failed_checks": [item["name"] for item in checks if not item["passed"]],
        "checks": checks,
        "phase7_mode": phase7.get("mode"),
        "authenticated_web_mode": auth.get("mode"),
        "executor_hooks_added": 1,
        "new_executor": False,
        "secrets_entered_by_alfred": False,
        "payment_data_supported": False,
        "captcha_supported": False,
        "cloud_models": False,
        "adversarial_suite": "phase8_test_and_live_smoke_required",
    }


@router.get("/v1/core/phase8/status")
async def phase8_status():
    return acceptance_status()

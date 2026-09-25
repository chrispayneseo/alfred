"""Phase 5F controlled browser integration for Alfred Core.

Browser actions are statically registered application code. Navigation and page
inspection are read-only. Form preparation is ephemeral and automatically allowed
only after a value-free DOM field safety check. Every actual submission remains a
high-impact exact-scope Core approval and passes through the existing executor,
Phase 5E verification/replay protection and restart recovery.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from fastapi import APIRouter

from . import browser_client
from .core import TOOLS

BROWSER_MODE = "controlled_browser_v1"
router = APIRouter(tags=["core-browser"])
_INSTALLED = False


def _valid_fingerprint(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(ch in "0123456789abcdef" for ch in value.casefold())
    )


def _verify_page(result: dict) -> dict:
    session_id = result.get("session_id")
    url = result.get("url")
    ok = (
        result.get("ok") is True
        and isinstance(session_id, str) and bool(session_id)
        and isinstance(url, str) and url.startswith(("http://", "https://"))
        and isinstance(result.get("title"), str)
        and isinstance(result.get("text"), str)
        and isinstance(result.get("links"), list)
        and isinstance(result.get("forms"), list)
        and isinstance(result.get("controls"), list)
        and _valid_fingerprint(result.get("state_fingerprint"))
        and result.get("untrusted_web_content") is True
        and result.get("network_mode") == "read_only"
    )
    return {
        "ok": ok,
        "method": "browser_page_state",
        "session_id": session_id,
        "state_fingerprint": result.get("state_fingerprint"),
        "untrusted_web_content": True,
    }


def _verify_prepare(result: dict) -> dict:
    ok = (
        result.get("ok") is True
        and isinstance(result.get("session_id"), str)
        and isinstance(result.get("prepared_count"), int)
        and result.get("prepared_count", 0) > 0
        and _valid_fingerprint(result.get("state_fingerprint"))
        and result.get("unsafe_requests") == 0
        and result.get("network_mode") == "offline_prepare"
        and result.get("values_exposed") is False
    )
    return {
        "ok": ok,
        "method": "browser_offline_form_state",
        "session_id": result.get("session_id"),
        "state_fingerprint": result.get("state_fingerprint"),
    }


def _verify_submit(result: dict) -> dict:
    key = result.get("idempotency_key")
    ok = (
        result.get("ok") is True
        and result.get("dispatch_verified") is True
        and isinstance(result.get("session_id"), str)
        and isinstance(key, str) and len(key) == 64
        and isinstance(result.get("target_origin"), str)
        and result.get("kind") in browser_client.SUBMIT_KINDS
        and isinstance(result.get("unsafe_request_count"), int)
        and isinstance(result.get("unsafe_response_count"), int)
    )
    return {
        "ok": ok,
        "method": "browser_submission_dispatch",
        "session_id": result.get("session_id"),
        "idempotency_key": key,
        "dispatch_verified": result.get("dispatch_verified") is True,
    }


def _verify_close(result: dict) -> dict:
    ok = (
        result.get("ok") is True
        and result.get("closed") is True
        and isinstance(result.get("session_id"), str)
    )
    return {"ok": ok, "method": "browser_session_closed", "session_id": result.get("session_id")}


def register_adapters() -> None:
    from . import integration_adapters

    entries = (
        integration_adapters.Adapter("browser.session.open", browser_client.open_session, _verify_page),
        integration_adapters.Adapter("browser.navigate", browser_client.navigate, _verify_page),
        integration_adapters.Adapter("browser.page.inspect", browser_client.inspect_page, _verify_page),
        integration_adapters.Adapter("browser.form.prepare", browser_client.prepare_form, _verify_prepare),
        integration_adapters.Adapter("browser.submit", browser_client.submit, _verify_submit),
        integration_adapters.Adapter("browser.session.close", browser_client.close_session, _verify_close),
    )
    for adapter in entries:
        integration_adapters.ADAPTERS[adapter.action] = adapter


def _denied(*, request_id: str, action: str, plan_id: str | None,
            step_index: int | None, reason: str) -> dict:
    return {
        "id": "browser-preflight-denied",
        "request_id": request_id,
        "plan_id": plan_id,
        "step_index": step_index,
        "action": action,
        "state": "denied",
        "result": None,
        "verification": None,
        "approval": None,
        "error": reason,
        "browser": {"preflight": "denied", "external_effect": False},
    }


def install() -> None:
    """Install browser adapters and a pre-execution safety guard.

    This must run before Phase 5E wraps execute_tool so resolved browser arguments
    still flow through the same reliability and approval stack afterwards.
    """
    global _INSTALLED
    if _INSTALLED:
        return

    from . import approval_engine, execution
    from .db import record_audit

    register_adapters()
    original_execute_tool = execution.execute_tool
    original_summary = execution._approval_summary
    original_effect = approval_engine._effect_for

    async def execute_tool_with_browser_guard(
        *, request_id: str, action: str, arguments: dict,
        plan_id: str | None = None, step_index: int | None = None,
    ) -> dict:
        if action not in browser_client.BROWSER_ACTIONS:
            return await original_execute_tool(
                request_id=request_id, action=action, arguments=arguments,
                plan_id=plan_id, step_index=step_index,
            )
        try:
            browser_client.validate_arguments(action, arguments)
            # Values are deliberately not sent during preflight. The worker checks
            # actual DOM metadata first so password/payment/file fields are rejected
            # before Core records or transmits their values for form preparation.
            if action == "browser.form.prepare":
                selectors = [str(item["selector"]) for item in arguments["fields"]]
                checked = await browser_client.validate_fields(arguments["session_id"], selectors)
                if checked.get("ok") is not True or checked.get("sensitive") is not False:
                    raise ValueError("Browser form fields failed safety preflight")
        except Exception as exc:
            record_audit(
                "browser.preflight_denied",
                {"action": action, "reason_type": type(exc).__name__, "external_effect": False},
                request_id,
            )
            return _denied(
                request_id=request_id, action=action, plan_id=plan_id,
                step_index=step_index, reason=str(exc) or "Browser safety preflight failed",
            )
        return await original_execute_tool(
            request_id=request_id, action=action, arguments=arguments,
            plan_id=plan_id, step_index=step_index,
        )

    def approval_summary(action: str, arguments: dict) -> str:
        if action == "browser.submit":
            kind = str(arguments.get("kind") or "form_submit").replace("_", " ")
            origin = str(arguments.get("target_origin") or "")
            host = urlsplit(origin).hostname or "the current website"
            return f"Submit the prepared {kind} action on {host}."
        return original_summary(action, arguments)

    def effect_for(action: str) -> str:
        if action == "browser.submit":
            return "submit_external_browser_action"
        return original_effect(action)

    execute_tool_with_browser_guard._phase5f_wrapped = True
    execution.execute_tool = execute_tool_with_browser_guard
    execution._approval_summary = approval_summary
    approval_engine._effect_for = effect_for
    execution._phase5f_browser_guard_enabled = True
    _INSTALLED = True


def status() -> dict:
    from .integrations import get_integration

    integration = get_integration("controlled_browser") or {}
    capabilities = integration.get("capabilities") or []
    return {
        "mode": BROWSER_MODE,
        "configured": bool(integration.get("configured")),
        "state": integration.get("state", "not_configured"),
        "enabled_capabilities": sum(1 for item in capabilities if item.get("enabled")),
        "total_capabilities": len(capabilities),
        "navigation": "public_http_https_only",
        "private_network_access": False,
        "untrusted_page_content": True,
        "form_prepare_network": "offline",
        "credential_fields": False,
        "payment_fields": False,
        "downloads": False,
        "file_uploads": False,
        "persistent_profiles": False,
        "submission_policy": "exact_scope_owner_approval",
        "submission_recovery": "phase5e_reconciliation_on_ambiguity",
        "cloud_models": False,
    }


@router.get("/v1/core/browser/status")
async def browser_status():
    return status()

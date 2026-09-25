"""Phase 8 secure authenticated web actions.

Authenticated sessions are bootstrapped by the owner outside Alfred's model and
Core instruction path. Core receives only an opaque profile id plus a public URL.
Passwords, passcodes, OTP/2FA values, card/CVV data and CAPTCHA answers are never
accepted as tool arguments or returned by the worker.

The new authenticated-session open action is registered into the existing Core
executor. Consequential submission still uses Phase 5F ``browser.submit`` with
exact-scope owner approval, Phase 5E verification and ambiguity reconciliation.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import browser_client, core, execution, integration_adapters

MODE = "secure_authenticated_web_v1"
AUTH_OPEN_ACTION = "browser.authenticated.session.open"
PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,31}$")
router = APIRouter(tags=["core-authenticated-web"])
_INSTALLED = False


class AuthenticatedOpen(BaseModel):
    profile_id: str = Field(min_length=3, max_length=32)
    url: str = Field(min_length=1, max_length=2048)


def _validate_profile_id(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Authenticated browser profile id is required")
    clean = value.strip().casefold()
    if not PROFILE_ID_RE.fullmatch(clean):
        raise ValueError("Invalid authenticated browser profile id")
    return clean


def _validate_url(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 2048:
        raise ValueError("Authenticated browser URL is required")
    clean = value.strip()
    parsed = urlsplit(clean)
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Authenticated browser URL must be HTTP(S)")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Credentials must not be embedded in browser URLs")
    return clean


def validate_arguments(arguments: dict) -> dict:
    if not isinstance(arguments, dict):
        raise ValueError("Authenticated browser arguments must be an object")
    if set(arguments) - {"profile_id", "url"}:
        raise ValueError("Unexpected authenticated browser arguments")
    return {
        "profile_id": _validate_profile_id(arguments.get("profile_id")),
        "url": _validate_url(arguments.get("url")),
    }


async def _worker_profiles() -> dict:
    return await browser_client._request("GET", "/v1/profiles")


async def _open(arguments: dict, _: str) -> dict:
    clean = validate_arguments(arguments)
    return await browser_client._request(
        "POST", "/v1/session/open-authenticated", payload=clean,
    )


def _verify_open(result: dict) -> dict:
    profile_id = result.get("authenticated_profile")
    fingerprint = result.get("state_fingerprint")
    ok = (
        result.get("ok") is True
        and isinstance(result.get("session_id"), str)
        and isinstance(profile_id, str)
        and bool(PROFILE_ID_RE.fullmatch(profile_id))
        and isinstance(result.get("url"), str)
        and isinstance(fingerprint, str) and len(fingerprint) == 64
        and result.get("credential_values_exposed") is False
        and result.get("profile_scope") == "origin_allowlist"
        and result.get("untrusted_web_content") is True
        and result.get("network_mode") == "read_only"
    )
    return {
        "ok": ok,
        "method": "authenticated_browser_page_state",
        "session_id": result.get("session_id"),
        "authenticated_profile": profile_id,
        "credential_values_exposed": False,
        "state_fingerprint": fingerprint,
    }


def install() -> None:
    """Register one read-only authenticated-session open action.

    The browser guard, reliability layer and executor remain the same objects
    installed by Phase 5. This extension adds no direct submit or mutation path.
    """
    global _INSTALLED
    if _INSTALLED:
        return

    core.TOOLS[AUTH_OPEN_ACTION] = {
        "risk": "read",
        "permission": "auto",
        "verification": "authenticated_browser_page_state",
    }
    browser_client.BROWSER_ACTIONS.add(AUTH_OPEN_ACTION)
    integration_adapters.ADAPTERS[AUTH_OPEN_ACTION] = integration_adapters.Adapter(
        AUTH_OPEN_ACTION, _open, _verify_open,
    )

    original_validate = browser_client.validate_arguments
    original_decide = execution.decide

    def validate_with_authenticated_profile(action: str, arguments: dict) -> None:
        if action == AUTH_OPEN_ACTION:
            validate_arguments(arguments)
            return
        original_validate(action, arguments)

    def decide_with_authenticated_profile(action: str, confirmed: bool = False):
        if action == AUTH_OPEN_ACTION:
            return core.PolicyDecision(
                "read", "auto",
                "Opening a human-bootstrapped authenticated browser session is read-only.",
            )
        return original_decide(action, confirmed)

    browser_client.validate_arguments = validate_with_authenticated_profile
    execution.decide = decide_with_authenticated_profile
    execution._phase8_authenticated_web_enabled = True
    _INSTALLED = True


def status() -> dict:
    return {
        "mode": MODE,
        "profile_bootstrap": "human_only",
        "profile_storage": "worker_storage_state_files",
        "profile_reference_in_core": "opaque_id_only",
        "password_entry_by_alfred": False,
        "otp_entry_by_alfred": False,
        "captcha_solving": False,
        "payment_card_entry": False,
        "downloads": False,
        "file_uploads": False,
        "authenticated_open_action": AUTH_OPEN_ACTION,
        "authenticated_open_policy": "read_only_auto",
        "consequential_submit_action": "browser.submit",
        "consequential_submit_policy": "phase5_exact_scope_owner_approval",
        "submission_kill_switch_preserved": True,
        "new_executor": False,
        "cloud_models": False,
    }


@router.get("/v1/core/authenticated-web/status")
async def authenticated_web_status():
    payload = status()
    try:
        worker = await _worker_profiles()
        profiles = worker.get("profiles") if isinstance(worker, dict) else []
        payload["worker_state"] = "ready"
        payload["profile_count"] = len(profiles) if isinstance(profiles, list) else 0
        payload["profiles"] = profiles if isinstance(profiles, list) else []
    except Exception:
        payload["worker_state"] = "unavailable"
        payload["profile_count"] = 0
        payload["profiles"] = []
    return payload


@router.post("/v1/core/authenticated-web/open")
async def open_authenticated_web(request: AuthenticatedOpen):
    result = await execution.execute_tool(
        request_id=f"phase8-auth-open:{request.profile_id}",
        action=AUTH_OPEN_ACTION,
        arguments={"profile_id": request.profile_id, "url": request.url},
    )
    if result.get("state") != "completed" or (result.get("verification") or {}).get("ok") is not True:
        error = result.get("error") or "Authenticated browser session could not be opened safely"
        raise HTTPException(status_code=503, detail=error)
    return result

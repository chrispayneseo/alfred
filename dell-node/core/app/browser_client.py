"""Client and validation boundary for Alfred Phase 5F controlled browser actions."""

from __future__ import annotations

import hashlib
import json
from urllib.parse import urlsplit

import httpx

from . import config

BROWSER_ACTIONS = {
    "browser.session.open",
    "browser.navigate",
    "browser.page.inspect",
    "browser.form.prepare",
    "browser.submit",
    "browser.session.close",
}
SUBMIT_KINDS = {"form_submit", "reservation", "purchase", "account_change", "other"}
SENSITIVE_TERMS = {
    "password", "passwd", "passcode", "pin", "otp", "totp", "2fa",
    "cvv", "cvc", "cardnumber", "card-number", "creditcard", "credit-card",
    "secret", "token", "securitycode", "security-code",
}


def configured() -> bool:
    return bool(config.settings.browser_enabled and config.settings.browser_worker_url and config.settings.browser_worker_token)


def _require_text(arguments: dict, key: str, *, max_length: int) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise ValueError(f"Missing or invalid argument: {key}")
    return value.strip()


def _validate_url_shape(url: str) -> str:
    if len(url) > 2048:
        raise ValueError("Browser URL is too long")
    parsed = urlsplit(url)
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Browser URL must be HTTP(S)")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Credentials must not be embedded in browser URLs")
    return url


def _validate_selector(selector: str) -> str:
    if not 1 <= len(selector) <= 300:
        raise ValueError("Invalid browser selector")
    lowered = selector.casefold().replace("_", "").replace("-", "").replace(" ", "")
    if any(term.replace("-", "") in lowered for term in SENSITIVE_TERMS):
        raise ValueError("Sensitive credential and payment fields are not supported")
    return selector


def validate_arguments(action: str, arguments: dict) -> None:
    if action not in BROWSER_ACTIONS:
        return
    if not isinstance(arguments, dict):
        raise ValueError("Browser arguments must be an object")
    if action == "browser.session.open":
        _validate_url_shape(_require_text(arguments, "url", max_length=2048))
        return
    session_id = _require_text(arguments, "session_id", max_length=64)
    if len(session_id) < 8:
        raise ValueError("Invalid browser session id")
    if action == "browser.navigate":
        _validate_url_shape(_require_text(arguments, "url", max_length=2048))
    elif action == "browser.page.inspect":
        if set(arguments) - {"session_id"}:
            raise ValueError("Unexpected browser inspect arguments")
    elif action == "browser.form.prepare":
        fields = arguments.get("fields")
        if not isinstance(fields, list) or not 1 <= len(fields) <= 20:
            raise ValueError("Browser form preparation requires 1 to 20 fields")
        for item in fields:
            if not isinstance(item, dict):
                raise ValueError("Invalid browser field")
            selector = _validate_selector(_require_text(item, "selector", max_length=300))
            value = item.get("value")
            if not isinstance(value, str) or len(value) > 1000:
                raise ValueError("Invalid browser field value")
            if set(item) - {"selector", "value"}:
                raise ValueError("Unexpected browser field arguments")
            _ = selector
    elif action == "browser.submit":
        _validate_selector(_require_text(arguments, "selector", max_length=300))
        fingerprint = _require_text(arguments, "state_fingerprint", max_length=64)
        if len(fingerprint) != 64 or any(ch not in "0123456789abcdef" for ch in fingerprint.casefold()):
            raise ValueError("Invalid browser state fingerprint")
        target_origin = _validate_url_shape(_require_text(arguments, "target_origin", max_length=300))
        parsed = urlsplit(target_origin)
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("Browser target_origin must contain only scheme and host")
        kind = _require_text(arguments, "kind", max_length=40)
        if kind not in SUBMIT_KINDS:
            raise ValueError("Invalid browser submission kind")
    elif action == "browser.session.close":
        if set(arguments) - {"session_id"}:
            raise ValueError("Unexpected browser close arguments")


def _worker_error(response: httpx.Response) -> Exception:
    detail = "Browser worker rejected the request"
    try:
        payload = response.json()
        if isinstance(payload, dict) and isinstance(payload.get("detail"), str):
            detail = payload["detail"]
    except Exception:
        pass
    # 4xx responses mean the worker rejected the action before an external effect.
    if 400 <= response.status_code < 500:
        return ValueError(detail)
    return RuntimeError("Browser worker failed while handling the action")


async def _request(method: str, path: str, *, payload: dict | None = None) -> dict:
    if not configured():
        raise RuntimeError("Controlled browser is not configured")
    headers = {"Authorization": f"Bearer {config.settings.browser_worker_token}"}
    timeout = httpx.Timeout(config.settings.browser_timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.request(
            method,
            f"{config.settings.browser_worker_url.rstrip('/')}{path}",
            headers=headers,
            json=payload,
        )
    if response.status_code >= 400:
        raise _worker_error(response)
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError("Browser worker returned an invalid response")
    return data


async def health() -> dict:
    if not configured():
        return {"state": "not_configured"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(min(config.settings.browser_timeout_seconds, 5.0))) as client:
            response = await client.get(f"{config.settings.browser_worker_url.rstrip('/')}/health")
        if response.status_code != 200:
            return {"state": "unavailable"}
        data = response.json()
        state = "ready" if isinstance(data, dict) and data.get("browser_ready") is True else "unavailable"
        return {
            "state": state,
            "headless": True,
            "persistent_profiles": False,
            "private_network_access": False,
            "downloads": False,
            "file_uploads": False,
        }
    except Exception:
        return {"state": "unavailable"}


def _submit_key(request_id: str, arguments: dict) -> str:
    encoded = json.dumps(
        {"request_id": request_id, "arguments": arguments},
        sort_keys=True, separators=(",", ":"), default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


async def validate_fields(session_id: str, selectors: list[str]) -> dict:
    return await _request(
        "POST", f"/v1/session/{session_id}/validate-fields",
        payload={"selectors": selectors},
    )


async def open_session(arguments: dict, _: str) -> dict:
    validate_arguments("browser.session.open", arguments)
    return await _request("POST", "/v1/session/open", payload={"url": arguments["url"]})


async def navigate(arguments: dict, _: str) -> dict:
    validate_arguments("browser.navigate", arguments)
    return await _request(
        "POST", f"/v1/session/{arguments['session_id']}/navigate",
        payload={"url": arguments["url"]},
    )


async def inspect_page(arguments: dict, _: str) -> dict:
    validate_arguments("browser.page.inspect", arguments)
    return await _request("GET", f"/v1/session/{arguments['session_id']}/inspect")


async def prepare_form(arguments: dict, _: str) -> dict:
    validate_arguments("browser.form.prepare", arguments)
    return await _request(
        "POST", f"/v1/session/{arguments['session_id']}/prepare",
        payload={"fields": arguments["fields"]},
    )


async def submit(arguments: dict, request_id: str) -> dict:
    validate_arguments("browser.submit", arguments)
    payload = {
        "selector": arguments["selector"],
        "state_fingerprint": arguments["state_fingerprint"],
        "target_origin": arguments["target_origin"],
        "kind": arguments["kind"],
        "idempotency_key": _submit_key(request_id, arguments),
    }
    return await _request(
        "POST", f"/v1/session/{arguments['session_id']}/submit", payload=payload,
    )


async def close_session(arguments: dict, _: str) -> dict:
    validate_arguments("browser.session.close", arguments)
    return await _request("DELETE", f"/v1/session/{arguments['session_id']}")

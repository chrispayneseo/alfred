from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from playwright.async_api import Browser, BrowserContext, Page, async_playwright

from .policy import (
    BrowserPolicyError,
    SENSITIVE_TERMS,
    method_allowed,
    origin_for,
    same_origin,
    state_fingerprint,
    validate_field_value,
    validate_public_url,
    validate_selector,
    validate_submit_kind,
)

TOKEN = os.getenv("ALFRED_BROWSER_WORKER_TOKEN", "")
MAX_SESSIONS = max(1, min(int(os.getenv("ALFRED_BROWSER_MAX_SESSIONS", "3")), 5))
SESSION_TTL_SECONDS = max(300, min(int(os.getenv("ALFRED_BROWSER_SESSION_TTL_SECONDS", "1800")), 7200))
NAVIGATION_TIMEOUT_MS = max(3000, min(int(os.getenv("ALFRED_BROWSER_NAVIGATION_TIMEOUT_MS", "15000")), 30000))
MAX_UNSAFE_REQUESTS_PER_SUBMIT = 8

_playwright = None
_browser: Browser | None = None


@dataclass
class Session:
    id: str
    context: BrowserContext
    page: Page
    created_at: float
    last_used: float
    prepared_fields: dict[str, str] = field(default_factory=dict)
    mode: str = "safe"
    submit_origin: str | None = None
    unsafe_requests: list[dict[str, Any]] = field(default_factory=list)
    unsafe_responses: list[dict[str, Any]] = field(default_factory=list)
    submissions: dict[str, dict] = field(default_factory=dict)

    def fingerprint(self) -> str:
        return state_fingerprint(self.page.url or "about:blank", self.prepared_fields)


SESSIONS: dict[str, Session] = {}


class OpenRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class NavigateRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class FieldValue(BaseModel):
    selector: str = Field(min_length=1, max_length=300)
    value: str = Field(max_length=1000)


class PrepareRequest(BaseModel):
    fields: list[FieldValue] = Field(min_length=1, max_length=20)


class ValidateFieldsRequest(BaseModel):
    selectors: list[str] = Field(min_length=1, max_length=20)


class SubmitRequest(BaseModel):
    selector: str = Field(min_length=1, max_length=300)
    state_fingerprint: str = Field(min_length=64, max_length=64)
    target_origin: str = Field(min_length=8, max_length=300)
    kind: str = Field(min_length=1, max_length=40)
    idempotency_key: str = Field(min_length=64, max_length=64)


def authorised(authorization: str = Header(default="")) -> None:
    if not TOKEN or authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="Browser worker authentication required")


async def _cleanup_expired() -> None:
    now = time.monotonic()
    expired = [sid for sid, item in SESSIONS.items() if now - item.last_used > SESSION_TTL_SECONDS]
    for sid in expired:
        item = SESSIONS.pop(sid, None)
        if item is not None:
            try:
                await item.context.close()
            except Exception:
                pass


async def _get_session(session_id: str) -> Session:
    await _cleanup_expired()
    item = SESSIONS.get(session_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Browser session not found")
    item.last_used = time.monotonic()
    return item


def _sensitive_metadata(metadata: dict[str, Any]) -> bool:
    if str(metadata.get("type") or "").casefold() in {"password", "file"}:
        return True
    joined = " ".join(
        str(metadata.get(key) or "")
        for key in ("name", "id", "autocomplete", "placeholder", "aria_label")
    ).casefold().replace("_", "").replace("-", "").replace(" ", "")
    return any(term.replace("-", "") in joined for term in SENSITIVE_TERMS)


async def _route_for(session: Session, route, request) -> None:
    url = request.url
    try:
        await asyncio.to_thread(validate_public_url, url)
    except Exception:
        await route.abort("blockedbyclient")
        return

    if request.resource_type in {"websocket", "eventsource"}:
        await route.abort("blockedbyclient")
        return

    if session.mode == "prepare":
        await route.abort("blockedbyclient")
        return

    same_target = bool(session.submit_origin and same_origin(url, session.submit_origin))
    if not method_allowed(request.method, submit_mode=session.mode == "submit", same_target_origin=same_target):
        await route.abort("blockedbyclient")
        return

    if request.method.upper() not in {"GET", "HEAD", "OPTIONS"}:
        if len(session.unsafe_requests) >= MAX_UNSAFE_REQUESTS_PER_SUBMIT:
            await route.abort("blockedbyclient")
            return
        session.unsafe_requests.append({
            "method": request.method.upper(),
            "origin": session.submit_origin,
        })
    await route.continue_()


async def _inspect(session: Session) -> dict:
    page = session.page
    text = (await page.locator("body").inner_text(timeout=5000))[:6000]
    links = await page.locator("a[href]").evaluate_all(
        "els => els.slice(0, 30).map(e => ({text:(e.innerText||'').trim().slice(0,160), href:e.href}))"
    )
    forms = await page.locator("form").evaluate_all(
        "els => els.slice(0, 10).map(e => ({method:(e.method||'get').toUpperCase(), action:e.action||location.href}))"
    )
    controls = await page.locator("input, textarea, select, button").evaluate_all(
        "els => els.slice(0, 40).map(e => ({tag:e.tagName.toLowerCase(), type:(e.type||'').toLowerCase(), name:e.name||'', id:e.id||'', placeholder:e.placeholder||'', autocomplete:e.autocomplete||'', aria_label:e.getAttribute('aria-label')||'', text:(e.innerText||e.value||'').trim().slice(0,120)}))"
    )
    safe_links = []
    for item in links:
        try:
            validate_public_url(str(item.get("href") or ""))
        except Exception:
            continue
        safe_links.append({"text": str(item.get("text") or "")[:160], "href": str(item["href"])[:2048]})
    safe_forms = []
    for form in forms:
        action = str(form.get("action") or "")
        try:
            validate_public_url(action)
        except Exception:
            continue
        safe_forms.append({"method": str(form.get("method") or "GET")[:10], "action": action[:2048]})
    safe_controls = []
    for control in controls:
        metadata = {key: str(value or "")[:160] for key, value in control.items()}
        metadata["sensitive"] = _sensitive_metadata(metadata)
        if metadata.get("tag") in {"input", "textarea", "select"}:
            metadata.pop("text", None)
        safe_controls.append(metadata)
    return {
        "ok": True,
        "session_id": session.id,
        "url": page.url[:2048],
        "title": (await page.title())[:300],
        "text": text,
        "links": safe_links,
        "forms": safe_forms,
        "controls": safe_controls,
        "state_fingerprint": session.fingerprint(),
        "untrusted_web_content": True,
        "network_mode": "read_only",
    }


async def _navigate(session: Session, url: str) -> dict:
    target = await asyncio.to_thread(validate_public_url, url)
    session.mode = "safe"
    session.submit_origin = None
    session.prepared_fields.clear()
    session.unsafe_requests.clear()
    session.unsafe_responses.clear()
    response = await session.page.goto(target, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
    status = response.status if response is not None else None
    if status is not None and status >= 400:
        raise HTTPException(status_code=502, detail="Browser navigation returned an error response")
    return await _inspect(session)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _playwright, _browser
    if TOKEN:
        _playwright = await async_playwright().start()
        _browser = await _playwright.chromium.launch(headless=True)
    try:
        yield
    finally:
        for item in list(SESSIONS.values()):
            try:
                await item.context.close()
            except Exception:
                pass
        SESSIONS.clear()
        if _browser is not None:
            await _browser.close()
            _browser = None
        if _playwright is not None:
            await _playwright.stop()
            _playwright = None


app = FastAPI(title="Alfred Browser Worker", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health():
    await _cleanup_expired()
    return {
        "status": "ok" if TOKEN and _browser is not None else "not_configured",
        "configured": bool(TOKEN),
        "browser_ready": _browser is not None,
        "sessions": len(SESSIONS),
        "max_sessions": MAX_SESSIONS,
        "session_ttl_seconds": SESSION_TTL_SECONDS,
        "headless": True,
        "persistent_profiles": False,
        "downloads": False,
        "file_uploads": False,
        "websockets": False,
        "private_network_access": False,
        "safe_mode_methods": sorted({"GET", "HEAD", "OPTIONS"}),
    }


@app.post("/v1/session/open", dependencies=[Depends(authorised)])
async def open_session(request: OpenRequest):
    await _cleanup_expired()
    if _browser is None:
        raise HTTPException(status_code=503, detail="Browser worker is not configured")
    if len(SESSIONS) >= MAX_SESSIONS:
        raise HTTPException(status_code=429, detail="Browser session limit reached")
    try:
        target = await asyncio.to_thread(validate_public_url, request.url)
    except BrowserPolicyError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    context = await _browser.new_context(
        accept_downloads=False,
        service_workers="block",
        java_script_enabled=True,
    )
    page = await context.new_page()
    page.set_default_timeout(NAVIGATION_TIMEOUT_MS)
    session = Session(
        id=str(uuid4()), context=context, page=page,
        created_at=time.monotonic(), last_used=time.monotonic(),
    )
    async def route_handler(route, req):
        await _route_for(session, route, req)

    await context.route("**/*", route_handler)
    page.on("dialog", lambda dialog: asyncio.create_task(dialog.dismiss()))
    SESSIONS[session.id] = session
    try:
        result = await _navigate(session, target)
    except Exception:
        SESSIONS.pop(session.id, None)
        await context.close()
        raise
    return result


@app.post("/v1/session/{session_id}/navigate", dependencies=[Depends(authorised)])
async def navigate(session_id: str, request: NavigateRequest):
    session = await _get_session(session_id)
    try:
        return await _navigate(session, request.url)
    except BrowserPolicyError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/v1/session/{session_id}/inspect", dependencies=[Depends(authorised)])
async def inspect(session_id: str):
    session = await _get_session(session_id)
    return await _inspect(session)


@app.post("/v1/session/{session_id}/validate-fields", dependencies=[Depends(authorised)])
async def validate_fields(session_id: str, request: ValidateFieldsRequest):
    session = await _get_session(session_id)
    checked = 0
    for raw_selector in request.selectors:
        try:
            selector = validate_selector(raw_selector)
        except BrowserPolicyError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        locator = session.page.locator(selector)
        if await locator.count() != 1:
            raise HTTPException(status_code=409, detail="Prepared field selector must match exactly one element")
        metadata = await locator.evaluate(
            "el => ({tag:el.tagName.toLowerCase(), type:(el.type||'').toLowerCase(), name:el.name||'', id:el.id||'', autocomplete:el.autocomplete||'', placeholder:el.placeholder||'', aria_label:el.getAttribute('aria-label')||''})"
        )
        if _sensitive_metadata(metadata):
            raise HTTPException(status_code=422, detail="Sensitive credential, payment and file fields are not supported")
        if metadata.get("tag") not in {"input", "textarea", "select"}:
            raise HTTPException(status_code=422, detail="Only form fields can be prepared")
        checked += 1
    return {"ok": True, "session_id": session.id, "checked": checked, "sensitive": False}


@app.post("/v1/session/{session_id}/prepare", dependencies=[Depends(authorised)])
async def prepare(session_id: str, request: PrepareRequest):
    session = await _get_session(session_id)
    await validate_fields(session_id, ValidateFieldsRequest(selectors=[item.selector for item in request.fields]))
    session.mode = "prepare"
    session.submit_origin = None
    try:
        for field_item in request.fields:
            selector = validate_selector(field_item.selector)
            value = validate_field_value(field_item.value)
            locator = session.page.locator(selector)
            metadata = await locator.evaluate(
                "el => ({tag:el.tagName.toLowerCase(), type:(el.type||'').toLowerCase()})"
            )
            if metadata.get("tag") == "select":
                await locator.select_option(value=value)
            else:
                await locator.fill(value)
            session.prepared_fields[selector] = value
    except BrowserPolicyError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        session.mode = "safe"

    return {
        "ok": True,
        "session_id": session.id,
        "url": session.page.url[:2048],
        "prepared_count": len(request.fields),
        "state_fingerprint": session.fingerprint(),
        "unsafe_requests": 0,
        "network_mode": "offline_prepare",
        "values_exposed": False,
    }


@app.post("/v1/session/{session_id}/submit", dependencies=[Depends(authorised)])
async def submit(session_id: str, request: SubmitRequest):
    session = await _get_session(session_id)
    try:
        selector = validate_selector(request.selector)
        kind = validate_submit_kind(request.kind)
        expected_origin = origin_for(request.target_origin)
    except BrowserPolicyError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if request.idempotency_key in session.submissions:
        replay = dict(session.submissions[request.idempotency_key])
        replay["replayed"] = True
        return replay
    if request.state_fingerprint != session.fingerprint():
        raise HTTPException(status_code=409, detail="Prepared browser state changed; approval scope is stale")
    current_origin = origin_for(session.page.url)
    if current_origin != expected_origin:
        raise HTTPException(status_code=409, detail="Browser target origin changed; approval scope is stale")

    locator = session.page.locator(selector)
    if await locator.count() != 1:
        raise HTTPException(status_code=409, detail="Submission selector must match exactly one element")
    metadata = await locator.evaluate(
        "el => ({tag:el.tagName.toLowerCase(), type:(el.type||'').toLowerCase(), role:el.getAttribute('role')||'', disabled:!!el.disabled})"
    )
    allowed = (
        metadata.get("tag") == "button"
        or (metadata.get("tag") == "input" and metadata.get("type") in {"submit", "button"})
        or metadata.get("role") == "button"
    )
    if not allowed or metadata.get("disabled"):
        raise HTTPException(status_code=422, detail="Submission target must be one enabled button")

    before_url = session.page.url
    session.mode = "submit"
    session.submit_origin = expected_origin
    session.unsafe_requests.clear()
    session.unsafe_responses.clear()

    def on_response(response) -> None:
        try:
            method = response.request.method.upper()
            if method not in {"GET", "HEAD", "OPTIONS"} and same_origin(response.url, expected_origin):
                session.unsafe_responses.append({"status": int(response.status), "method": method})
        except Exception:
            pass

    session.page.on("response", on_response)
    try:
        await locator.click(timeout=NAVIGATION_TIMEOUT_MS)
        try:
            await session.page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        await session.page.wait_for_timeout(750)
    finally:
        session.page.remove_listener("response", on_response)
        session.mode = "safe"
        session.submit_origin = None

    after_url = session.page.url
    good_mutation_response = any(200 <= int(item.get("status", 999)) < 400 for item in session.unsafe_responses)
    navigation_changed = after_url != before_url
    dispatch_verified = good_mutation_response or navigation_changed
    result = {
        "ok": dispatch_verified,
        "session_id": session.id,
        "kind": kind,
        "target_origin": expected_origin,
        "idempotency_key": request.idempotency_key,
        "dispatch_verified": dispatch_verified,
        "navigation_changed": navigation_changed,
        "unsafe_request_count": len(session.unsafe_requests),
        "unsafe_response_count": len(session.unsafe_responses),
        "final_url": after_url[:2048],
        "state_fingerprint_before": request.state_fingerprint,
        "untrusted_web_content": True,
    }
    session.submissions[request.idempotency_key] = dict(result)
    session.prepared_fields.clear()
    return result


@app.delete("/v1/session/{session_id}", dependencies=[Depends(authorised)])
async def close_session(session_id: str):
    session = SESSIONS.pop(session_id, None)
    if session is None:
        return {"ok": True, "closed": True, "session_id": session_id, "already_closed": True}
    await session.context.close()
    return {"ok": True, "closed": True, "session_id": session_id, "already_closed": False}

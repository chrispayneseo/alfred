from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import main
from .policy import BrowserPolicyError, origin_for, validate_public_url

PROFILE_ROOT = Path(os.getenv("ALFRED_BROWSER_PROFILE_ROOT", "/profiles"))
PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,31}$")
router = APIRouter(tags=["authenticated-browser-profiles"])


class AuthenticatedOpenRequest(BaseModel):
    profile_id: str = Field(min_length=3, max_length=32)
    url: str = Field(min_length=1, max_length=2048)


def _safe_profile_id(value: str) -> str:
    clean = str(value or "").strip().casefold()
    if not PROFILE_ID_RE.fullmatch(clean):
        raise HTTPException(status_code=422, detail="Invalid browser profile id")
    return clean


def _paths(profile_id: str) -> tuple[Path, Path]:
    clean = _safe_profile_id(profile_id)
    root = PROFILE_ROOT.resolve()
    meta = (root / f"{clean}.meta.json").resolve()
    state = (root / f"{clean}.state.json").resolve()
    if meta.parent != root or state.parent != root:
        raise HTTPException(status_code=422, detail="Invalid browser profile path")
    return meta, state


def _load_profile(profile_id: str) -> dict[str, Any]:
    meta_path, state_path = _paths(profile_id)
    if not meta_path.is_file() or not state_path.is_file():
        raise HTTPException(status_code=404, detail="Authenticated browser profile not found")
    try:
        raw = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=503, detail="Authenticated browser profile metadata is unavailable") from exc
    if not isinstance(raw, dict):
        raise HTTPException(status_code=503, detail="Authenticated browser profile metadata is invalid")
    allowed = raw.get("allowed_origins")
    if not isinstance(allowed, list) or not 1 <= len(allowed) <= 10:
        raise HTTPException(status_code=503, detail="Authenticated browser profile has no valid origin scope")
    origins: list[str] = []
    for value in allowed:
        if not isinstance(value, str):
            raise HTTPException(status_code=503, detail="Authenticated browser profile origin scope is invalid")
        try:
            origins.append(origin_for(value))
        except (BrowserPolicyError, ValueError) as exc:
            raise HTTPException(status_code=503, detail="Authenticated browser profile origin scope is invalid") from exc
    return {
        "id": _safe_profile_id(profile_id),
        "label": str(raw.get("label") or profile_id)[:80],
        "allowed_origins": sorted(set(origins)),
        "created_at": str(raw.get("created_at") or ""),
        "state_path": state_path,
    }


def profile_summaries() -> list[dict[str, Any]]:
    try:
        candidates = sorted(PROFILE_ROOT.glob("*.meta.json"))
    except OSError:
        return []
    items: list[dict[str, Any]] = []
    for meta in candidates[:50]:
        profile_id = meta.name.removesuffix(".meta.json")
        try:
            profile = _load_profile(profile_id)
        except HTTPException:
            continue
        items.append({
            "id": profile["id"],
            "label": profile["label"],
            "allowed_origins": profile["allowed_origins"],
            "created_at": profile["created_at"],
            "available": True,
        })
    return items


async def _open_authenticated(profile: dict[str, Any], target: str) -> dict:
    await main._cleanup_expired()
    if main._browser is None:
        raise HTTPException(status_code=503, detail="Browser worker is not configured")
    if len(main.SESSIONS) >= main.MAX_SESSIONS:
        raise HTTPException(status_code=429, detail="Browser session limit reached")
    try:
        target = await main.asyncio.to_thread(validate_public_url, target)
        target_origin = origin_for(target)
    except BrowserPolicyError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if target_origin not in profile["allowed_origins"]:
        raise HTTPException(status_code=422, detail="Requested URL is outside this authenticated profile's origin scope")

    context = await main._browser.new_context(
        storage_state=str(profile["state_path"]),
        accept_downloads=False,
        service_workers="block",
        java_script_enabled=True,
    )
    page = await context.new_page()
    page.set_default_timeout(main.NAVIGATION_TIMEOUT_MS)
    session = main.Session(
        id=str(main.uuid4()),
        context=context,
        page=page,
        created_at=time.monotonic(),
        last_used=time.monotonic(),
    )
    session.authenticated_profile = profile["id"]
    session.allowed_origins = tuple(profile["allowed_origins"])

    async def route_handler(route, request):
        try:
            requested_origin = origin_for(request.url)
        except Exception:
            await route.abort("blockedbyclient")
            return
        if requested_origin not in session.allowed_origins:
            await route.abort("blockedbyclient")
            return
        await main._route_for(session, route, request)

    await context.route("**/*", route_handler)
    page.on("dialog", lambda dialog: main.asyncio.create_task(dialog.dismiss()))
    main.SESSIONS[session.id] = session
    try:
        result = await main._navigate(session, target)
    except Exception:
        main.SESSIONS.pop(session.id, None)
        await context.close()
        raise
    result["authenticated_profile"] = profile["id"]
    result["profile_scope"] = "origin_allowlist"
    result["credential_values_exposed"] = False
    return result


@router.get("/v1/profiles", dependencies=[Depends(main.authorised)])
async def list_profiles():
    return {
        "profiles": profile_summaries(),
        "secret_values_exposed": False,
        "human_bootstrap_required": True,
    }


@router.post("/v1/session/open-authenticated", dependencies=[Depends(main.authorised)])
async def open_authenticated_session(request: AuthenticatedOpenRequest):
    profile = _load_profile(request.profile_id)
    return await _open_authenticated(profile, request.url)

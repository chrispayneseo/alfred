"""Policy-gated generic phone nudges for Alfred's proactive assistant.

This module is the only outbound surface for proactive observations. It reuses
Alfred's existing validated ntfy topic and never sends connected item content.
Phase 4G adds an owner-triggered test nudge and an optional once-per-day generic
morning-brief-ready nudge, both using fixed messages only.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import HTTPException

from . import inbox_api, proactive, proactive_brief
from .config import settings
from .db import connection, record_audit

CHANNEL = "ntfy_generic"
RETRY_BACKOFF_MINUTES = 30
GENERIC_MESSAGE = "Alfred has something worth checking. Open Alfred Today to review it."
MORNING_BRIEF_MESSAGE = "Your Alfred morning brief is ready. Open Alfred Today to review it."
TEST_MESSAGE = "Alfred test notification. Phone nudges are working."
GENERIC_TITLE = "Alfred"
_FALLBACK_TODAY_URL = "https://alfred-five-livid.vercel.app/today"
_REGISTERED = False


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS proactive_deliveries (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            state TEXT NOT NULL,
            attempted_at TEXT NOT NULL,
            delivered_at TEXT,
            error_type TEXT,
            UNIQUE(item_id, channel)
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS proactive_deliveries_attempted ON proactive_deliveries(attempted_at DESC)")


def _utc_stamp(now: datetime | None = None) -> str:
    value = now or datetime.now(timezone.utc)
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _parse_stamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _today_url() -> str:
    for raw in str(settings.web_origin or "").split(","):
        candidate = raw.strip().rstrip("/")
        if not candidate:
            continue
        parsed = urlparse(candidate)
        if parsed.scheme in {"https", "http"} and parsed.netloc:
            return f"{candidate}/today"
    return _FALLBACK_TODAY_URL


def _record_for_item(item_id: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute("""SELECT id, state, attempted_at, delivered_at, error_type
            FROM proactive_deliveries WHERE item_id = ? AND channel = ?""",
            (item_id, CHANNEL)).fetchone()
    return dict(row) if row else None


def _record_attempt(item_id: str, *, now: datetime) -> str:
    delivery_id = str(uuid4())
    stamp = _utc_stamp(now)
    with connection() as db:
        db.execute("""INSERT INTO proactive_deliveries
            (id, item_id, channel, state, attempted_at, delivered_at, error_type)
            VALUES (?, ?, ?, 'attempting', ?, NULL, NULL)
            ON CONFLICT(item_id, channel) DO UPDATE SET
                state = 'attempting', attempted_at = excluded.attempted_at,
                delivered_at = NULL, error_type = NULL""",
            (delivery_id, item_id, CHANNEL, stamp))
        row = db.execute("SELECT id FROM proactive_deliveries WHERE item_id = ? AND channel = ?",
                         (item_id, CHANNEL)).fetchone()
    return str(row["id"])


def _record_failure(item_id: str, error_type: str) -> None:
    with connection() as db:
        db.execute("""UPDATE proactive_deliveries
            SET state = 'failed', error_type = ?, delivered_at = NULL
            WHERE item_id = ? AND channel = ?""", (error_type, item_id, CHANNEL))


def _record_success(item_id: str, *, now: datetime) -> None:
    with connection() as db:
        db.execute("""UPDATE proactive_deliveries
            SET state = 'delivered', delivered_at = ?, error_type = NULL
            WHERE item_id = ? AND channel = ?""", (_utc_stamp(now), item_id, CHANNEL))


async def _send_ntfy(topic: str, message: str) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            f"https://ntfy.sh/{topic}",
            content=message,
            headers={"Title": GENERIC_TITLE, "Click": _today_url()},
        )
        response.raise_for_status()


async def _deliver_once(item_id: str, message: str, *, now: datetime) -> dict:
    existing = _record_for_item(item_id)
    if existing and existing.get("delivered_at"):
        return {"state": "already_delivered", "channel": CHANNEL}

    attempted = _parse_stamp(existing.get("attempted_at") if existing else None)
    utc_now = now.astimezone(timezone.utc)
    if attempted is not None and utc_now - attempted < timedelta(minutes=RETRY_BACKOFF_MINUTES):
        return {"state": "retry_backoff", "channel": CHANNEL}

    topic = inbox_api.notification_topic()
    if topic is None:
        return {"state": "not_configured", "channel": CHANNEL}

    _record_attempt(item_id, now=now)
    try:
        await _send_ntfy(topic, message)
    except httpx.HTTPError as exc:
        error_type = type(exc).__name__
        _record_failure(item_id, error_type)
        record_audit("proactive.delivery_failed", {
            "channel": CHANNEL,
            "error_type": error_type,
        })
        return {"state": "failed", "channel": CHANNEL, "error_type": error_type}

    _record_success(item_id, now=now)
    return {"state": "delivered", "channel": CHANNEL, "content_policy": "generic_only"}


def delivery_status() -> dict:
    initialise()
    topic_ready = inbox_api.notification_topic() is not None
    with connection() as db:
        last = db.execute("""SELECT state, attempted_at, delivered_at, error_type
            FROM proactive_deliveries ORDER BY attempted_at DESC LIMIT 1""").fetchone()
        delivered_count = int(db.execute(
            "SELECT COUNT(*) FROM proactive_deliveries WHERE state = 'delivered'"
        ).fetchone()[0])
    last_state = dict(last) if last else None
    return {
        "enabled": bool(settings.proactive_push_enabled),
        "morning_brief_enabled": bool(settings.proactive_morning_brief_push_enabled),
        "configured": bool(topic_ready),
        "channel": CHANNEL,
        "content_policy": "generic_only",
        "destination": "today",
        "retry_backoff_minutes": RETRY_BACKOFF_MINUTES,
        "delivered_count": delivered_count,
        "last": last_state,
    }


async def maybe_deliver(*, now: datetime | None = None) -> dict:
    """Send at most one successful generic nudge per proactive item."""
    initialise()
    local_now = proactive._aware_now(now)
    if not settings.proactive_push_enabled:
        return {"state": "disabled", "channel": CHANNEL}

    decision = proactive_brief.interruption_decision(now=local_now)
    if decision.get("decision") != "surface_candidate" or not decision.get("item"):
        return {"state": str(decision.get("decision") or "held"), "channel": CHANNEL}

    item_id = str(decision["item"].get("id") or "")
    if not item_id:
        return {"state": "invalid_candidate", "channel": CHANNEL}

    result = await _deliver_once(item_id, GENERIC_MESSAGE, now=local_now)
    if result.get("state") == "delivered":
        proactive_brief.mark_surfaced(item_id, now=local_now)
        record_audit("proactive.delivered", {
            "channel": CHANNEL,
            "purpose": "interruption",
            "content_policy": "generic_only",
        })
    return result


async def maybe_deliver_morning_brief(brief: dict | None, *, now: datetime | None = None) -> dict:
    """Send one generic brief-ready nudge per local day, never brief content."""
    initialise()
    local_now = proactive._aware_now(now)
    if not settings.proactive_push_enabled or not settings.proactive_morning_brief_push_enabled:
        return {"state": "disabled", "channel": CHANNEL}
    if brief is None:
        return {"state": "no_brief", "channel": CHANNEL}
    if proactive.quiet_hours_active(local_now):
        return {"state": "hold_quiet_hours", "channel": CHANNEL}

    counts = brief.get("counts") or {}
    if int(counts.get("total", 0)) <= 0:
        return {"state": "nothing_to_surface", "channel": CHANNEL}

    brief_date = str(brief.get("brief_date") or "")
    if not brief_date:
        return {"state": "invalid_brief", "channel": CHANNEL}

    result = await _deliver_once(f"morning-brief:{brief_date}", MORNING_BRIEF_MESSAGE, now=local_now)
    if result.get("state") == "delivered":
        items = brief.get("items") or []
        if items and items[0].get("id"):
            proactive_brief.mark_surfaced(str(items[0]["id"]), now=local_now)
        record_audit("proactive.morning_brief_delivered", {
            "channel": CHANNEL,
            "brief_date": brief_date,
            "content_policy": "generic_only",
        })
    return result


async def send_test_nudge() -> dict:
    """Owner-triggered fixed test message; never source-derived content."""
    if not settings.proactive_push_enabled:
        raise HTTPException(status_code=409, detail="Generic phone nudges are disabled")
    topic = inbox_api.notification_topic()
    if topic is None:
        raise HTTPException(status_code=409, detail="ntfy is not configured")
    try:
        await _send_ntfy(topic, TEST_MESSAGE)
    except httpx.HTTPError as exc:
        record_audit("proactive.test_delivery_failed", {
            "channel": CHANNEL,
            "error_type": type(exc).__name__,
        })
        raise HTTPException(status_code=502, detail="Test notification delivery failed") from exc
    record_audit("proactive.test_delivered", {
        "channel": CHANNEL,
        "content_policy": "fixed_test_only",
    })
    return {"state": "delivered", "channel": CHANNEL, "content_policy": "fixed_test_only"}


def register_routes() -> None:
    global _REGISTERED
    if _REGISTERED:
        return

    @proactive.router.get("/delivery/status")
    async def proactive_delivery_status():
        return delivery_status()

    @proactive.router.post("/delivery/test")
    async def proactive_delivery_test():
        return await send_test_nudge()

    _REGISTERED = True

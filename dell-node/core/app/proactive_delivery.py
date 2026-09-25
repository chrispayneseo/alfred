"""Phase 4F policy-gated generic phone nudges.

This module is the only outbound surface for proactive observations. It reuses
Alfred's existing validated ntfy topic, never sends item titles/summaries/source
content, and only sends after the deterministic interruption policy returns a
surface candidate. Delivery is opt-in and disabled by default.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from uuid import uuid4

import httpx

from . import inbox_api, proactive, proactive_brief
from .config import settings
from .db import connection, record_audit

CHANNEL = "ntfy_generic"
RETRY_BACKOFF_MINUTES = 30
GENERIC_MESSAGE = "Alfred has something worth checking. Open Alfred Today to review it."
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


async def _send_generic_nudge(topic: str) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            f"https://ntfy.sh/{topic}",
            content=GENERIC_MESSAGE,
            headers={"Title": GENERIC_TITLE, "Click": _today_url()},
        )
        response.raise_for_status()


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

    topic = inbox_api.notification_topic()
    if topic is None:
        return {"state": "not_configured", "channel": CHANNEL}

    decision = proactive_brief.interruption_decision(now=local_now)
    if decision.get("decision") != "surface_candidate" or not decision.get("item"):
        return {"state": str(decision.get("decision") or "held"), "channel": CHANNEL}

    item_id = str(decision["item"].get("id") or "")
    if not item_id:
        return {"state": "invalid_candidate", "channel": CHANNEL}

    existing = _record_for_item(item_id)
    if existing and existing.get("delivered_at"):
        return {"state": "already_delivered", "channel": CHANNEL}

    attempted = _parse_stamp(existing.get("attempted_at") if existing else None)
    utc_now = local_now.astimezone(timezone.utc)
    if attempted is not None and utc_now - attempted < timedelta(minutes=RETRY_BACKOFF_MINUTES):
        return {"state": "retry_backoff", "channel": CHANNEL}

    _record_attempt(item_id, now=local_now)
    try:
        await _send_generic_nudge(topic)
    except httpx.HTTPError as exc:
        error_type = type(exc).__name__
        _record_failure(item_id, error_type)
        record_audit("proactive.delivery_failed", {
            "channel": CHANNEL,
            "error_type": error_type,
        })
        return {"state": "failed", "channel": CHANNEL, "error_type": error_type}

    _record_success(item_id, now=local_now)
    proactive_brief.mark_surfaced(item_id, now=local_now)
    record_audit("proactive.delivered", {
        "channel": CHANNEL,
        "content_policy": "generic_only",
    })
    return {"state": "delivered", "channel": CHANNEL, "content_policy": "generic_only"}


def register_routes() -> None:
    global _REGISTERED
    if _REGISTERED:
        return

    @proactive.router.get("/delivery/status")
    async def proactive_delivery_status():
        return delivery_status()

    _REGISTERED = True

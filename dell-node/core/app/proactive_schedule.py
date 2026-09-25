"""Scheduled local observation, durable morning briefs, and gated nudges.

The scheduler refreshes Alfred's local proactive feed and stores at most one
morning-brief snapshot per local calendar day. Phase 4F may also ask the
policy-gated delivery layer to send a generic phone nudge. The delivery layer is
separately opt-in and never receives or transmits brief/item content.
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime, time, timedelta
import json
from uuid import uuid4

from fastapi import HTTPException

from . import proactive, proactive_brief, proactive_delivery
from .config import settings
from .db import connection, record_audit

_REGISTERED = False
_INSTALLED = False


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS proactive_briefs (
            id TEXT PRIMARY KEY,
            brief_date TEXT NOT NULL UNIQUE,
            generated_at TEXT NOT NULL,
            headline TEXT NOT NULL,
            counts TEXT NOT NULL,
            items TEXT NOT NULL,
            source_run_id TEXT,
            synthesis TEXT NOT NULL DEFAULT 'deterministic_local',
            delivery TEXT NOT NULL DEFAULT 'disabled'
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS proactive_briefs_generated ON proactive_briefs(generated_at DESC)")


def _scheduled_time() -> time:
    try:
        return time.fromisoformat(settings.proactive_morning_brief_time.strip())
    except (AttributeError, ValueError):
        return time(8, 0)


def _max_items() -> int:
    return max(1, min(int(settings.proactive_morning_brief_max_items), 20))


def _retention_days() -> int:
    return max(1, min(int(settings.proactive_brief_retention_days), 365))


def _decode(row) -> dict | None:
    if row is None:
        return None
    item = dict(row)
    try:
        item["counts"] = json.loads(item.get("counts") or "{}")
    except json.JSONDecodeError:
        item["counts"] = {}
    try:
        item["items"] = json.loads(item.get("items") or "[]")
    except json.JSONDecodeError:
        item["items"] = []
    return item


def get_for_date(brief_date: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute("""SELECT id, brief_date, generated_at, headline, counts, items,
                source_run_id, synthesis, delivery
            FROM proactive_briefs WHERE brief_date = ?""", (brief_date,)).fetchone()
    return _decode(row)


def latest() -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute("""SELECT id, brief_date, generated_at, headline, counts, items,
                source_run_id, synthesis, delivery
            FROM proactive_briefs ORDER BY brief_date DESC, generated_at DESC LIMIT 1""").fetchone()
    return _decode(row)


def _prune(local_day: date) -> None:
    cutoff = (local_day - timedelta(days=_retention_days())).isoformat()
    with connection() as db:
        db.execute("DELETE FROM proactive_briefs WHERE brief_date < ?", (cutoff,))


def due_status(*, now: datetime | None = None) -> dict:
    initialise()
    local_now = proactive._aware_now(now)
    day = local_now.date().isoformat()
    existing = get_for_date(day)
    enabled = bool(settings.proactive_morning_brief_enabled)
    scheduled = _scheduled_time()
    before_schedule = local_now.timetz().replace(tzinfo=None) < scheduled
    if not enabled:
        reason = "disabled"
        due = False
    elif existing is not None:
        reason = "already_generated"
        due = False
    elif before_schedule:
        reason = "before_schedule"
        due = False
    else:
        reason = "due"
        due = True
    return {
        "enabled": enabled,
        "scheduled_time": scheduled.strftime("%H:%M"),
        "local_date": day,
        "due": due,
        "reason": reason,
        "today_generated": existing is not None,
        "latest_brief_date": (latest() or {}).get("brief_date"),
        "delivery": "disabled",
    }


def generate_snapshot(*, now: datetime | None = None, source_run_id: str | None = None) -> dict:
    initialise()
    local_now = proactive._aware_now(now)
    day = local_now.date().isoformat()
    existing = get_for_date(day)
    if existing is not None:
        return {"generated": False, "reason": "already_generated", "brief": existing}

    brief = proactive_brief.build_brief(limit=_max_items(), now=local_now)
    brief_id = str(uuid4())
    generated_at = local_now.isoformat()
    with connection() as db:
        db.execute("""INSERT OR IGNORE INTO proactive_briefs
            (id, brief_date, generated_at, headline, counts, items, source_run_id, synthesis, delivery)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'disabled')""",
            (
                brief_id,
                day,
                generated_at,
                str(brief.get("headline") or "Morning brief"),
                json.dumps(brief.get("counts") or {}, separators=(",", ":")),
                json.dumps(brief.get("items") or [], separators=(",", ":")),
                source_run_id,
                str(brief.get("synthesis") or "deterministic_local"),
            ),
        )
    stored = get_for_date(day)
    if stored is None:
        raise RuntimeError("Morning brief was not stored")
    generated = stored.get("id") == brief_id
    _prune(local_now.date())
    if generated:
        record_audit("proactive.morning_brief_generated", {
            "brief_id": brief_id,
            "brief_date": day,
            "counts": stored.get("counts", {}),
            "delivery": "disabled",
        })
    return {
        "generated": generated,
        "reason": "generated" if generated else "already_generated",
        "brief": stored,
    }


async def generate_now(*, now: datetime | None = None) -> dict:
    local_now = proactive._aware_now(now)
    refresh_result = await proactive.refresh(now=local_now)
    return generate_snapshot(now=local_now, source_run_id=refresh_result.get("run_id"))


async def maybe_generate(*, now: datetime | None = None, source_run_id: str | None = None) -> dict:
    state = due_status(now=now)
    if not state["due"]:
        return {"generated": False, "reason": state["reason"], "brief": get_for_date(state["local_date"])}
    return generate_snapshot(now=now, source_run_id=source_run_id)


async def scheduled_background_loop() -> None:
    """Refresh, store any due brief, then evaluate generic push delivery."""
    while True:
        if settings.proactive_enabled:
            try:
                result = await proactive.refresh()
                await maybe_generate(source_run_id=result.get("run_id"))
                await proactive_delivery.maybe_deliver()
            except Exception as exc:
                record_audit("proactive.background_failed", {"error_type": type(exc).__name__})
        await asyncio.sleep(max(60, int(settings.proactive_poll_seconds)))


def install_background_loop() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    proactive.background_loop = scheduled_background_loop
    _INSTALLED = True


def register_routes() -> None:
    global _REGISTERED
    if _REGISTERED:
        return

    @proactive.router.get("/morning-brief/status")
    async def morning_brief_status():
        return due_status()

    @proactive.router.get("/morning-brief/latest")
    async def morning_brief_latest():
        item = latest()
        if item is None:
            raise HTTPException(status_code=404, detail="No morning brief has been generated")
        return item

    @proactive.router.post("/morning-brief/generate")
    async def morning_brief_generate():
        return await generate_now()

    _REGISTERED = True

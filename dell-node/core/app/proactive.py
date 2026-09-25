"""Local-first proactive observation engine for Alfred Phase 4.

The engine only reads already-authorised Alfred sources (tasks/reminders,
Calendar and Gmail), applies deterministic urgency rules, and stores a local
feed. It never calls a language model and never performs an external mutation.
Outbound delivery is intentionally not implemented in this phase-4 foundation.
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime, time, timedelta, timezone
import hashlib
import json
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import gmail, google_calendar, task_service
from .config import settings
from .db import connection, record_audit


router = APIRouter(prefix="/v1/core/proactive", tags=["proactive"])


class SnoozeRequest(BaseModel):
    minutes: int = Field(ge=15, le=10080)


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS proactive_items (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            source TEXT NOT NULL,
            priority INTEGER NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            source_ref TEXT,
            first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            surfaced_at TEXT,
            dismissed_at TEXT,
            snoozed_until TEXT,
            active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
        )""")
        db.execute("""CREATE INDEX IF NOT EXISTS proactive_items_feed
            ON proactive_items(active, dismissed_at, priority DESC, last_seen_at DESC)""")
        db.execute("""CREATE TABLE IF NOT EXISTS proactive_runs (
            id TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            signal_count INTEGER NOT NULL DEFAULT 0,
            sources TEXT NOT NULL,
            started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT,
            error_type TEXT
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS proactive_runs_started ON proactive_runs(started_at DESC)")


def _zone() -> ZoneInfo:
    try:
        return ZoneInfo(settings.timezone)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _aware_now(now: datetime | None = None) -> datetime:
    if now is None:
        return datetime.now(_zone())
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(_zone())


def _clock(value: str, fallback: time) -> time:
    try:
        return time.fromisoformat(value.strip())
    except (AttributeError, ValueError):
        return fallback


def quiet_hours_active(now: datetime | None = None) -> bool:
    local = _aware_now(now)
    start = _clock(settings.proactive_quiet_start, time(22, 0))
    end = _clock(settings.proactive_quiet_end, time(7, 0))
    current = local.timetz().replace(tzinfo=None)
    if start == end:
        return False
    if start < end:
        return start <= current < end
    return current >= start or current < end


def _fingerprint(*parts: object) -> str:
    raw = "\x1f".join(str(part) for part in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _signal(*, kind: str, source: str, priority: int, title: str,
            summary: str, source_ref: str | None, identity: tuple[object, ...]) -> dict:
    return {
        "id": str(uuid4()),
        "fingerprint": _fingerprint(source, kind, *identity),
        "kind": kind[:64],
        "source": source,
        "priority": max(0, min(int(priority), 100)),
        "title": title.strip()[:200] or "Alfred update",
        "summary": summary.strip()[:500],
        "source_ref": source_ref[:512] if isinstance(source_ref, str) else None,
    }


def _task_signals(now: datetime) -> list[dict]:
    today = now.date()
    horizon = today + timedelta(days=max(0, min(settings.proactive_task_horizon_days, 14)))
    signals: list[dict] = []
    for item in task_service.list_items(include_completed=False, limit=100):
        due_raw = item.get("due")
        if not isinstance(due_raw, str) or not due_raw:
            continue
        try:
            due = date.fromisoformat(due_raw)
        except ValueError:
            continue
        if due > horizon:
            continue
        delta = (due - today).days
        kind = str(item.get("kind") or "task")
        if delta < 0:
            priority, signal_kind = 95, "overdue"
            timing = f"Overdue since {due.isoformat()}."
        elif delta == 0:
            priority, signal_kind = (90 if kind == "reminder" else 82), "due_today"
            timing = "Due today."
        elif delta == 1:
            priority, signal_kind = 70, "due_soon"
            timing = "Due tomorrow."
        else:
            priority, signal_kind = 55, "due_soon"
            timing = f"Due {due.isoformat()}."
        source_id = str(item.get("source_id") or "")
        title = str(item.get("title") or "Task")
        signals.append(_signal(
            kind=signal_kind,
            source="tasks",
            priority=priority,
            title=title,
            summary=timing,
            source_ref=source_id or None,
            identity=(source_id, due.isoformat()),
        ))
    return signals


def _calendar_start(event: dict, zone: ZoneInfo) -> tuple[datetime | None, bool]:
    raw = event.get("start")
    if not isinstance(raw, str) or not raw:
        return None, False
    if bool(event.get("all_day")):
        try:
            day = date.fromisoformat(raw[:10])
        except ValueError:
            return None, True
        return datetime.combine(day, time.min, tzinfo=zone), True
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None, False
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None, False
    return parsed.astimezone(zone), False


async def _calendar_signals(now: datetime) -> tuple[list[dict], dict]:
    if not google_calendar.configured():
        return [], {"state": "not_configured"}
    end = now + timedelta(hours=max(1, min(settings.proactive_calendar_hours, 72)))
    try:
        payload = await google_calendar.list_events(now.isoformat(), end.isoformat(), limit=20)
    except Exception as exc:
        return [], {"state": "unavailable", "error_type": type(exc).__name__}
    signals: list[dict] = []
    for event in payload.get("events", []) if isinstance(payload, dict) else []:
        if not isinstance(event, dict):
            continue
        start, all_day = _calendar_start(event, _zone())
        if start is None:
            continue
        hours = (start - now).total_seconds() / 3600
        if all_day:
            priority = 64
            timing = "All-day calendar event."
        elif hours <= 2:
            priority = 90
            timing = f"Starts at {start.strftime('%H:%M')}."
        elif hours <= 6:
            priority = 80
            timing = f"Starts at {start.strftime('%H:%M')}."
        else:
            priority = 65
            timing = f"Starts {start.strftime('%a %H:%M')}."
        event_id = str(event.get("id") or "")
        title = str(event.get("summary") or "Calendar event")
        signals.append(_signal(
            kind="calendar_upcoming",
            source="calendar",
            priority=priority,
            title=title,
            summary=timing,
            source_ref=event_id or None,
            identity=(event_id, str(event.get("start") or "")),
        ))
    return signals, {"state": "ready", "count": len(signals)}


async def _gmail_signals(now: datetime) -> tuple[list[dict], dict]:
    if not gmail.configured():
        return [], {"state": "not_configured"}
    try:
        payload = await gmail.search_messages(settings.proactive_gmail_query, limit=10)
    except Exception as exc:
        return [], {"state": "unavailable", "error_type": type(exc).__name__}
    messages = payload.get("messages", []) if isinstance(payload, dict) else []
    count = len(messages) if isinstance(messages, list) else 0
    if count == 0:
        return [], {"state": "ready", "count": 0}
    priority = 70 if count >= 10 else 58
    signal = _signal(
        kind="unread_email",
        source="gmail",
        priority=priority,
        title="Unread email" if count == 1 else "Unread emails",
        summary=f"{count} recent unread email{' is' if count == 1 else 's are'} waiting.",
        source_ref=None,
        identity=(now.date().isoformat(),),
    )
    return [signal], {"state": "ready", "count": count}


def _store(signals: list[dict], successful_sources: set[str]) -> None:
    with connection() as db:
        for source in successful_sources:
            db.execute("UPDATE proactive_items SET active = 0 WHERE source = ?", (source,))
        for item in signals:
            db.execute("""INSERT INTO proactive_items
                (id, fingerprint, kind, source, priority, title, summary, source_ref)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(fingerprint) DO UPDATE SET
                    kind = excluded.kind,
                    priority = excluded.priority,
                    title = excluded.title,
                    summary = excluded.summary,
                    source_ref = excluded.source_ref,
                    last_seen_at = CURRENT_TIMESTAMP,
                    active = 1""",
                (item["id"], item["fingerprint"], item["kind"], item["source"],
                 item["priority"], item["title"], item["summary"], item["source_ref"]),
            )


async def refresh(*, now: datetime | None = None) -> dict:
    initialise()
    local_now = _aware_now(now)
    run_id = str(uuid4())
    sources: dict[str, dict] = {"tasks": {"state": "ready"}}
    with connection() as db:
        db.execute(
            "INSERT INTO proactive_runs (id, state, sources) VALUES (?, 'running', ?)",
            (run_id, "{}"),
        )
    try:
        task_signals = _task_signals(local_now)
        sources["tasks"]["count"] = len(task_signals)
        calendar_signals, calendar_state = await _calendar_signals(local_now)
        gmail_signals, gmail_state = await _gmail_signals(local_now)
        sources["calendar"] = calendar_state
        sources["gmail"] = gmail_state
        signals = task_signals + calendar_signals + gmail_signals
        successful = {source for source, state in sources.items() if state.get("state") in {"ready", "not_configured"}}
        _store(signals, successful)
        degraded = any(state.get("state") == "unavailable" for state in sources.values())
        state = "degraded" if degraded else "completed"
        with connection() as db:
            db.execute("""UPDATE proactive_runs
                SET state = ?, signal_count = ?, sources = ?, completed_at = CURRENT_TIMESTAMP
                WHERE id = ?""",
                (state, len(signals), json.dumps(sources, separators=(",", ":")), run_id),
            )
        record_audit("proactive.refresh", {
            "run_id": run_id,
            "state": state,
            "signal_count": len(signals),
            "sources": {name: value.get("state") for name, value in sources.items()},
        })
        return {"run_id": run_id, "state": state, "signal_count": len(signals), "sources": sources}
    except Exception as exc:
        with connection() as db:
            db.execute("""UPDATE proactive_runs SET state = 'failed', completed_at = CURRENT_TIMESTAMP,
                error_type = ? WHERE id = ?""", (type(exc).__name__, run_id))
        record_audit("proactive.refresh_failed", {"run_id": run_id, "error_type": type(exc).__name__})
        raise


def _last_run() -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute("""SELECT id, state, signal_count, sources, started_at, completed_at, error_type
            FROM proactive_runs ORDER BY started_at DESC LIMIT 1""").fetchone()
    if row is None:
        return None
    item = dict(row)
    try:
        item["sources"] = json.loads(item.get("sources") or "{}")
    except json.JSONDecodeError:
        item["sources"] = {}
    return item


def status(*, now: datetime | None = None) -> dict:
    initialise()
    with connection() as db:
        active = db.execute("""SELECT COUNT(*) FROM proactive_items
            WHERE active = 1 AND dismissed_at IS NULL""").fetchone()[0]
    return {
        "phase": 4,
        "enabled": bool(settings.proactive_enabled),
        "mode": "observation_feed",
        "delivery": "disabled",
        "quiet_hours": {
            "start": settings.proactive_quiet_start,
            "end": settings.proactive_quiet_end,
            "active": quiet_hours_active(now),
        },
        "poll_seconds": settings.proactive_poll_seconds,
        "min_priority": settings.proactive_min_priority,
        "cooldown_minutes": settings.proactive_cooldown_minutes,
        "active_items": int(active),
        "last_run": _last_run(),
    }


def feed(*, limit: int = 20, now: datetime | None = None) -> dict:
    initialise()
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
        raise ValueError("Feed limit must be between 1 and 100")
    local_now = _aware_now(now)
    utc_now = local_now.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    with connection() as db:
        rows = db.execute("""SELECT id, kind, source, priority, title, summary, source_ref,
                first_seen_at, last_seen_at, surfaced_at, snoozed_until
            FROM proactive_items
            WHERE active = 1 AND dismissed_at IS NULL
              AND (snoozed_until IS NULL OR snoozed_until <= ?)
            ORDER BY priority DESC, last_seen_at DESC LIMIT ?""", (utc_now, limit)).fetchall()
    quiet = quiet_hours_active(local_now)
    items = []
    for row in rows:
        item = dict(row)
        item["delivery_ready"] = (not quiet and int(item["priority"]) >= settings.proactive_min_priority)
        items.append(item)
    return {"items": items, "count": len(items), "quiet_hours": quiet, "delivery": "disabled"}


def dismiss(item_id: str) -> bool:
    initialise()
    with connection() as db:
        result = db.execute(
            "UPDATE proactive_items SET dismissed_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1",
            (item_id,),
        )
    return bool(result.rowcount)


def snooze(item_id: str, minutes: int) -> bool:
    initialise()
    if not isinstance(minutes, int) or isinstance(minutes, bool) or minutes < 15 or minutes > 10080:
        raise ValueError("Snooze must be between 15 minutes and 7 days")
    until = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
    with connection() as db:
        result = db.execute("""UPDATE proactive_items
            SET snoozed_until = ?, dismissed_at = NULL
            WHERE id = ? AND active = 1""", (until, item_id))
    return bool(result.rowcount)


async def background_loop() -> None:
    while True:
        if settings.proactive_enabled:
            try:
                await refresh()
            except Exception as exc:
                record_audit("proactive.background_failed", {"error_type": type(exc).__name__})
        await asyncio.sleep(max(60, settings.proactive_poll_seconds))


@router.get("/status")
async def get_status():
    return status()


@router.post("/refresh")
async def refresh_now():
    return await refresh()


@router.get("/feed")
async def get_feed(limit: int = 20):
    try:
        return feed(limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/items/{item_id}/dismiss")
async def dismiss_item(item_id: str):
    if not dismiss(item_id):
        raise HTTPException(status_code=404, detail="Proactive item not found")
    return {"dismissed": True}


@router.post("/items/{item_id}/snooze")
async def snooze_item(item_id: str, request: SnoozeRequest):
    if not snooze(item_id, request.minutes):
        raise HTTPException(status_code=404, detail="Proactive item not found")
    return {"snoozed": True, "minutes": request.minutes}

"""Explicit local feedback learning for Alfred Phase 4J.

Only owner actions already taken in Alfred (dismiss and snooze) are learned from.
The learner stores source/kind/action/timestamp only: no Gmail subject, sender,
snippet, Calendar title, task title, summary, source reference or model output.

Feedback can only lower relevance. It never creates urgency, never demotes an
item that is already in Alfred's >=90 urgent band, and never performs an
external mutation or model call.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from .db import connection, record_audit


FEEDBACK_MODE = "explicit_local_v1"
WINDOW_DAYS = 30
MAX_DISMISS_PENALTY = 18
MAX_SNOOZE_PENALTY = 4
MAX_TOTAL_PENALTY = 18
_REGISTERED = False


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS proactive_feedback_events (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            kind TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('dismiss', 'snooze')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute("""CREATE INDEX IF NOT EXISTS proactive_feedback_lookup
            ON proactive_feedback_events(source, kind, action, created_at DESC)""")


def _utc_stamp(value: datetime | None = None) -> str:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None or current.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return current.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def record_action(item_id: str, action: str, *, now: datetime | None = None) -> bool:
    """Record content-free owner feedback for one existing proactive item."""
    if action not in {"dismiss", "snooze"}:
        raise ValueError("Unsupported proactive feedback action")
    initialise()
    with connection() as db:
        row = db.execute(
            "SELECT source, kind FROM proactive_items WHERE id = ?",
            (item_id,),
        ).fetchone()
        if row is None:
            return False
        db.execute(
            """INSERT INTO proactive_feedback_events(id, source, kind, action, created_at)
            VALUES (?, ?, ?, ?, ?)""",
            (str(uuid4()), str(row["source"]), str(row["kind"]), action, _utc_stamp(now)),
        )
    record_audit("proactive.feedback_recorded", {
        "source": str(row["source"]),
        "kind": str(row["kind"]),
        "action": action,
        "content_stored": False,
    })
    return True


def _recent_counts(*, now: datetime | None = None) -> dict[tuple[str, str], dict[str, int]]:
    initialise()
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None or current.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    cutoff = _utc_stamp(current - timedelta(days=WINDOW_DAYS))
    with connection() as db:
        rows = db.execute("""SELECT source, kind, action, COUNT(*) AS count
            FROM proactive_feedback_events
            WHERE created_at >= ?
            GROUP BY source, kind, action""", (cutoff,)).fetchall()
    result: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"dismiss": 0, "snooze": 0})
    for row in rows:
        key = (str(row["source"]), str(row["kind"]))
        action = str(row["action"])
        if action in {"dismiss", "snooze"}:
            result[key][action] = int(row["count"])
    return dict(result)


def _penalty(*, dismiss_count: int, snooze_count: int) -> int:
    # A dismissal is strong explicit negative feedback. One snooze is treated as
    # timing only; repeated snoozes add a very small generalisation penalty.
    dismiss_penalty = min(MAX_DISMISS_PENALTY, max(0, dismiss_count) * 6)
    snooze_penalty = min(MAX_SNOOZE_PENALTY, max(0, snooze_count - 1) * 2)
    return min(MAX_TOTAL_PENALTY, dismiss_penalty + snooze_penalty)


def apply_feedback(items: list[dict], *, now: datetime | None = None) -> dict:
    """Return copies of items with bounded content-free feedback demotions."""
    counts = _recent_counts(now=now)
    adjusted: list[dict] = []
    adjusted_count = 0

    for raw in items:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        source = str(item.get("source") or "")
        kind = str(item.get("kind") or "")
        try:
            priority = max(0, min(int(item.get("priority", 0)), 100))
        except (TypeError, ValueError):
            priority = 0
        event_counts = counts.get((source, kind), {"dismiss": 0, "snooze": 0})
        penalty = _penalty(
            dismiss_count=int(event_counts.get("dismiss", 0)),
            snooze_count=int(event_counts.get("snooze", 0)),
        )

        # Explicit urgent items are never demoted by learned noise preferences.
        effective = priority if priority >= 90 else max(0, priority - penalty)
        item["pre_feedback_priority"] = priority
        item["priority"] = effective
        if effective < priority:
            item["feedback_adjustment"] = effective - priority
            item["feedback"] = {
                "dismissals": int(event_counts.get("dismiss", 0)),
                "snoozes": int(event_counts.get("snooze", 0)),
                "window_days": WINDOW_DAYS,
            }
            adjusted_count += 1
        adjusted.append(item)

    adjusted.sort(key=lambda item: (-int(item.get("priority", 0)), str(item.get("id") or "")))
    return {
        "mode": FEEDBACK_MODE,
        "items": adjusted,
        "adjusted_items": adjusted_count,
        "window_days": WINDOW_DAYS,
        "creates_urgent": False,
        "demotes_urgent": False,
        "cloud_models": False,
        "stores_connected_content": False,
    }


def status(*, now: datetime | None = None) -> dict:
    counts = _recent_counts(now=now)
    dismissals = sum(value.get("dismiss", 0) for value in counts.values())
    snoozes = sum(value.get("snooze", 0) for value in counts.values())
    learned_kinds = sum(1 for value in counts.values() if value.get("dismiss", 0) or value.get("snooze", 0))
    return {
        "mode": FEEDBACK_MODE,
        "window_days": WINDOW_DAYS,
        "dismissals": int(dismissals),
        "snoozes": int(snoozes),
        "learned_kinds": int(learned_kinds),
        "creates_urgent": False,
        "demotes_urgent": False,
        "cloud_models": False,
        "stores_connected_content": False,
    }


def reset() -> int:
    initialise()
    with connection() as db:
        count = int(db.execute("SELECT COUNT(*) FROM proactive_feedback_events").fetchone()[0])
        db.execute("DELETE FROM proactive_feedback_events")
    record_audit("proactive.feedback_reset", {"deleted_events": count})
    return count


def register_routes() -> None:
    global _REGISTERED
    if _REGISTERED:
        return
    from . import proactive

    @proactive.router.get("/feedback/status")
    async def feedback_status():
        return status()

    @proactive.router.post("/feedback/reset")
    async def feedback_reset():
        return {"reset": True, "deleted_events": reset(), "status": status()}

    _REGISTERED = True

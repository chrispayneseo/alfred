"""Deterministic Phase 4 briefing and interruption policy.

Consumes Alfred's local proactive feed only. No model calls, external service
calls, or outbound delivery happen here.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .config import settings
from .db import connection, record_audit

URGENT_PRIORITY = 90
IMPORTANT_PRIORITY = 70


def _last_surface_age_minutes(now: datetime) -> float | None:
    from . import proactive
    proactive.initialise()
    with connection() as db:
        row = db.execute(
            "SELECT MAX(surfaced_at) AS surfaced_at FROM proactive_items WHERE surfaced_at IS NOT NULL"
        ).fetchone()
    raw = row["surfaced_at"] if row else None
    if not raw:
        return None
    try:
        surfaced = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return max(0.0, (now.astimezone(timezone.utc) - surfaced).total_seconds() / 60.0)


def build_brief(*, limit: int = 8, now: datetime | None = None) -> dict:
    from . import proactive
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
        raise ValueError("Brief limit must be between 1 and 20")
    local_now = proactive._aware_now(now)
    data = proactive.feed(limit=100, now=local_now)
    items = list(data.get("items", []))
    urgent = [x for x in items if int(x.get("priority", 0)) >= URGENT_PRIORITY]
    important = [x for x in items if IMPORTANT_PRIORITY <= int(x.get("priority", 0)) < URGENT_PRIORITY]
    later = [x for x in items if int(x.get("priority", 0)) < IMPORTANT_PRIORITY]
    selected = (urgent + important + later)[:limit]
    if urgent:
        headline = f"{len(urgent)} urgent item{'s' if len(urgent) != 1 else ''} need attention."
    elif important:
        headline = f"{len(important)} item{'s' if len(important) != 1 else ''} worth checking."
    elif later:
        headline = f"{len(later)} lower-priority item{'s' if len(later) != 1 else ''} on the radar."
    else:
        headline = "Nothing currently needs your attention."
    return {
        "generated_at": local_now.isoformat(),
        "headline": headline,
        "quiet_hours": bool(data.get("quiet_hours")),
        "counts": {"total": len(items), "urgent": len(urgent), "important": len(important), "later": len(later)},
        "items": [{
            "id": x.get("id"), "source": x.get("source"), "kind": x.get("kind"),
            "priority": int(x.get("priority", 0)),
            "band": "urgent" if int(x.get("priority", 0)) >= URGENT_PRIORITY else "important" if int(x.get("priority", 0)) >= IMPORTANT_PRIORITY else "later",
            "title": x.get("title"), "summary": x.get("summary"),
        } for x in selected],
        "delivery": "disabled",
        "synthesis": "deterministic_local",
    }


def interruption_decision(*, now: datetime | None = None) -> dict:
    from . import proactive
    local_now = proactive._aware_now(now)
    if proactive.quiet_hours_active(local_now):
        return {"decision": "hold_quiet_hours", "item": None, "delivery": "disabled"}
    data = proactive.feed(limit=100, now=local_now)
    candidates = [x for x in data.get("items", []) if int(x.get("priority", 0)) >= int(settings.proactive_min_priority)]
    if not candidates:
        return {"decision": "nothing_to_surface", "item": None, "delivery": "disabled"}
    top = candidates[0]
    priority = int(top.get("priority", 0))
    age = _last_surface_age_minutes(local_now)
    cooldown = max(0, int(settings.proactive_cooldown_minutes))
    if priority < URGENT_PRIORITY and age is not None and age < cooldown:
        return {
            "decision": "hold_cooldown",
            "cooldown_remaining_minutes": max(0, int(round(cooldown - age))),
            "item": None,
            "delivery": "disabled",
        }
    return {
        "decision": "surface_candidate",
        "item": {"id": top.get("id"), "source": top.get("source"), "kind": top.get("kind"), "priority": priority,
                 "title": top.get("title"), "summary": top.get("summary")},
        "delivery": "disabled",
    }


def mark_surfaced(item_id: str, *, now: datetime | None = None) -> bool:
    from . import proactive
    local_now = proactive._aware_now(now)
    stamp = local_now.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    proactive.initialise()
    with connection() as db:
        result = db.execute(
            "UPDATE proactive_items SET surfaced_at = ? WHERE id = ? AND active = 1 AND dismissed_at IS NULL",
            (stamp, item_id),
        )
    if result.rowcount:
        record_audit("proactive.surfaced", {"item_id": item_id, "delivery": "disabled"})
    return bool(result.rowcount)

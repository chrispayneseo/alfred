"""Phase 10 selective proactive intelligence.

The engine derives bounded, explainable signals from Alfred's existing local
state. It never creates an external action, never calls a cloud model and never
turns itself into a daily briefing. Interventions are in-app attention items;
existing quiet-hours/delivery systems remain separate and unchanged.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter

from . import daily_operations, knowledge

MODE = "selective_proactive_intelligence_v1"
DELIVERY = "in_app_event_driven"
MAX_SIGNALS = 40
router = APIRouter(tags=["core-proactive-intelligence"])


def _signal(*, signal_id: str, kind: str, severity: str, title: str, reason: str,
            route: str, source: str, interruption: bool = False, due: str | None = None) -> dict:
    return {
        "id": signal_id,
        "kind": kind,
        "severity": severity,
        "title": title[:180],
        "reason": reason[:300],
        "route": route,
        "source": source,
        "interruption": bool(interruption),
        "due": due,
    }


def signals() -> dict:
    daily = daily_operations.today_view()
    today = date.fromisoformat(str(daily["date"]))
    items: list[dict] = []

    for item in daily.get("open_local_items", []):
        due = item.get("due")
        if not due:
            continue
        try:
            due_date = date.fromisoformat(str(due))
        except ValueError:
            continue
        title = str(item.get("title") or "Local commitment")
        if due_date < today:
            days = (today - due_date).days
            items.append(_signal(
                signal_id=f"overdue:{item.get('source_id')}", kind="overdue_commitment",
                severity="urgent" if days >= 2 else "attention", title=title,
                reason=f"This local commitment is {days} day(s) overdue.", route="/today",
                source="local_task", interruption=days >= 2, due=str(due),
            ))
        elif due_date == today:
            items.append(_signal(
                signal_id=f"due:{item.get('source_id')}", kind="due_today",
                severity="attention", title=title, reason="This local commitment is due today.",
                route="/today", source="local_task", due=str(due),
            ))

    for need in daily.get("needs_you", []):
        need_type = str(need.get("type") or "attention")
        reason = str(need.get("reason") or "attention_required")
        if need_type == "agent_approval":
            items.append(_signal(
                signal_id=f"approval:{need.get('id')}", kind="waiting_approval",
                severity="attention", title=str(need.get("action") or "Alfred needs approval"),
                reason="A planned change is paused at the existing exact-scope owner approval gate.",
                route="/inbox", source="agent", interruption=False,
            ))
        elif need_type == "agent_attention":
            urgent = str(need.get("state")) in {"reconciliation_required", "failed_terminal", "retry_exhausted"}
            items.append(_signal(
                signal_id=f"agent:{need.get('id')}", kind="execution_attention",
                severity="urgent" if urgent else "attention",
                title=str(need.get("action") or "Alfred execution needs attention"),
                reason=str(need.get("why") or reason), route="/inbox", source="agent",
                interruption=urgent,
            ))
        elif reason in {"clarification_required", "review_required"}:
            items.append(_signal(
                signal_id=f"capture:{need.get('id')}", kind="captured_item_review",
                severity="normal", title=str(need.get("title") or "Captured item needs review"),
                reason="A captured item needs owner review before Alfred can use it.",
                route="/capture", source="capture",
            ))

    for conflict in knowledge.contradictions(10):
        items.append(_signal(
            signal_id=f"memory-conflict:{conflict.get('candidate_id')}", kind="knowledge_conflict",
            severity="normal", title="Memory conflict needs review",
            reason="A new personal-knowledge candidate conflicts with an existing durable memory.",
            route="/settings", source="knowledge",
        ))

    kstatus = knowledge.status()
    stale = int(kstatus.get("stale_review_candidates", 0))
    if stale:
        items.append(_signal(
            signal_id="knowledge:stale-review", kind="stale_knowledge",
            severity="low", title=f"{stale} older memory item(s) may need review",
            reason="Older durable knowledge is flagged for review, not automatically deleted or changed.",
            route="/settings", source="knowledge",
        ))

    priority = {"urgent": 0, "attention": 1, "normal": 2, "low": 3}
    items.sort(key=lambda item: (priority.get(item["severity"], 9), item["id"]))
    items = items[:MAX_SIGNALS]
    return {
        "mode": MODE,
        "delivery": DELIVERY,
        "date": daily["date"],
        "count": len(items),
        "interruptions": sum(1 for item in items if item["interruption"]),
        "items": items,
        "daily_briefing": False,
        "unsolicited_cloud_reasoning": False,
        "automatic_external_action": False,
        "cloud_models": False,
    }


def status() -> dict:
    return {
        "mode": MODE,
        "delivery": DELIVERY,
        "inputs": ["local_commitments", "agent_state", "reviewed_capture", "personal_knowledge"],
        "deadline_detection": True,
        "approval_detection": True,
        "execution_problem_detection": True,
        "knowledge_conflict_detection": True,
        "stale_knowledge_detection": True,
        "calendar_conflict_detection": "existing_proactive_calendar_signals_only",
        "daily_briefing": False,
        "unsolicited_cloud_reasoning": False,
        "automatic_external_action": False,
        "new_executor": False,
        "cloud_models": False,
    }


@router.get("/v1/core/intelligence/status")
async def intelligence_status():
    return status()


@router.get("/v1/core/intelligence/signals")
async def intelligence_signals():
    return signals()

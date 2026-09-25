"""Deterministic cross-source reasoning for Alfred Phase 4I.

This layer consumes Alfred's already content-minimised local proactive feed and
adds bounded relevance boosts when independent sources support the same near-term
need. It never calls a model or an external service, never creates a synthetic
mutation target, and cannot promote a previously non-urgent item into the >=90
cooldown-bypass band.
"""

from __future__ import annotations

from collections import defaultdict
import re
from typing import Iterable


REASONING_MODE = "deterministic_cross_source_v1"

_STOPWORDS = {
    "about", "after", "again", "appointment", "before", "calendar", "check",
    "email", "event", "from", "have", "meeting", "notes", "reminder", "task",
    "that", "the", "this", "today", "tomorrow", "with", "your",
}

_DOMAIN_TOKENS: dict[str, set[str]] = {
    "gmail_finance": {
        "bank", "bill", "card", "credit", "debit", "finance", "invoice", "mortgage",
        "pay", "payment", "refund", "renewal", "tax",
    },
    "gmail_delivery": {
        "collect", "collection", "courier", "deliver", "delivery", "parcel", "post",
        "package", "pickup", "ship", "shipping",
    },
    "gmail_security": {
        "account", "login", "password", "security", "signin", "verification", "verify",
    },
    "gmail_booking": {
        "appointment", "booking", "flight", "hotel", "journey", "reservation", "ticket",
        "train", "travel",
    },
}


def _normalise(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return value.casefold().replace("sign-in", "signin").replace("sign in", "signin")


def _tokens(value: object) -> set[str]:
    words = re.findall(r"[a-z0-9]+", _normalise(value))
    return {
        word for word in words
        if len(word) >= 4 and word not in _STOPWORDS and not word.isdigit()
    }


def _base_priority(item: dict) -> int:
    try:
        return max(0, min(int(item.get("priority", 0)), 100))
    except (TypeError, ValueError):
        return 0


def _bounded_priority(base: int, boost: int) -> int:
    """Cross-source evidence never invents cooldown-bypass urgency."""
    if base >= 90:
        return min(99, base + max(0, boost))
    return min(89, base + max(0, boost))


def _same_topic(left: dict, right: dict) -> bool:
    left_tokens = _tokens(left.get("title"))
    right_tokens = _tokens(right.get("title"))
    if not left_tokens or not right_tokens:
        return False
    shared = left_tokens & right_tokens
    if not shared:
        return False
    # One distinctive token is enough; generic words were removed above.
    return any(len(token) >= 5 for token in shared) or len(shared) >= 2


def _task_matches_domain(task: dict, gmail_kind: str) -> bool:
    wanted = _DOMAIN_TOKENS.get(gmail_kind)
    if not wanted:
        return False
    return bool(_tokens(task.get("title")) & wanted)


def apply_cross_source_reasoning(items: Iterable[dict]) -> dict:
    """Return copies of feed items with bounded deterministic relevance boosts."""
    safe_items = [dict(item) for item in items if isinstance(item, dict)]
    boosts: dict[str, int] = defaultdict(int)
    reasons: dict[str, set[str]] = defaultdict(set)
    correlated_sources: dict[str, set[str]] = defaultdict(set)
    clusters: list[dict] = []

    def item_id(item: dict) -> str:
        return str(item.get("id") or "")

    def add_pair(left: dict, right: dict, *, boost_left: int, boost_right: int,
                 reason: str, cluster_type: str) -> None:
        left_id = item_id(left)
        right_id = item_id(right)
        if not left_id or not right_id or left_id == right_id:
            return
        left_source = str(left.get("source") or "")
        right_source = str(right.get("source") or "")
        if not left_source or not right_source or left_source == right_source:
            return
        boosts[left_id] += max(0, boost_left)
        boosts[right_id] += max(0, boost_right)
        reasons[left_id].add(reason)
        reasons[right_id].add(reason)
        correlated_sources[left_id].add(right_source)
        correlated_sources[right_id].add(left_source)
        clusters.append({
            "type": cluster_type,
            "sources": sorted({left_source, right_source}),
            "item_ids": sorted({left_id, right_id}),
        })

    tasks = [item for item in safe_items if item.get("source") == "tasks"]
    calendars = [item for item in safe_items if item.get("source") == "calendar"]
    gmail_items = [item for item in safe_items if item.get("source") == "gmail"]

    # Strongest deterministic relationship: task and calendar titles share a
    # distinctive local topic token. Content stays local and is not copied into
    # reasoning metadata.
    for task in tasks:
        for calendar in calendars:
            if _same_topic(task, calendar):
                add_pair(
                    task, calendar,
                    boost_left=8, boost_right=8,
                    reason="Related task and calendar item",
                    cluster_type="task_calendar_topic",
                )

    gmail_by_kind = {str(item.get("kind") or ""): item for item in gmail_items}

    # Booking/travel mail is useful supporting evidence when there is already a
    # near-term calendar event. Do not infer that they are the same booking.
    booking = gmail_by_kind.get("gmail_booking")
    if booking:
        for calendar in calendars:
            if _base_priority(calendar) >= 66:
                add_pair(
                    booking, calendar,
                    boost_left=3, boost_right=5,
                    reason="Booking email and near-term calendar context",
                    cluster_type="booking_calendar_context",
                )

    # A generic action-needed email adds modest weight to a task that is already
    # due or overdue. It does not claim the email and task refer to each other.
    action = gmail_by_kind.get("gmail_action")
    if action:
        for task in tasks:
            if str(task.get("kind") or "") in {"overdue", "due_today"}:
                add_pair(
                    action, task,
                    boost_left=2, boost_right=4,
                    reason="Action email alongside a due task",
                    cluster_type="action_due_task_context",
                )

    # Domain-specific correlations require an explicit task-title domain token,
    # which keeps these rules more conservative than generic co-occurrence.
    for gmail_kind in ("gmail_finance", "gmail_delivery", "gmail_security", "gmail_booking"):
        gmail_item = gmail_by_kind.get(gmail_kind)
        if not gmail_item:
            continue
        for task in tasks:
            if _task_matches_domain(task, gmail_kind):
                add_pair(
                    gmail_item, task,
                    boost_left=3, boost_right=6,
                    reason="Related source context",
                    cluster_type=f"{gmail_kind.removeprefix('gmail_')}_task_context",
                )

    enriched: list[dict] = []
    for item in safe_items:
        identifier = item_id(item)
        base = _base_priority(item)
        boost = min(12, int(boosts.get(identifier, 0)))
        effective = _bounded_priority(base, boost)
        enriched_item = dict(item)
        enriched_item["base_priority"] = base
        enriched_item["priority"] = effective
        if boost > 0:
            enriched_item["reasoning_boost"] = effective - base
            enriched_item["reasoning"] = sorted(reasons.get(identifier, set()))
            enriched_item["correlated_sources"] = sorted(correlated_sources.get(identifier, set()))
        enriched.append(enriched_item)

    enriched.sort(key=lambda item: (-_base_priority(item), str(item.get("id") or "")))

    # Deduplicate identical generic cluster records created by overlapping rules.
    unique_clusters: list[dict] = []
    seen: set[tuple] = set()
    for cluster in clusters:
        key = (
            cluster["type"],
            tuple(cluster["sources"]),
            tuple(cluster["item_ids"]),
        )
        if key in seen:
            continue
        seen.add(key)
        unique_clusters.append(cluster)

    return {
        "mode": REASONING_MODE,
        "items": enriched,
        "clusters": unique_clusters,
        "cluster_count": len(unique_clusters),
        "boosted_items": sum(1 for item in enriched if int(item.get("reasoning_boost", 0)) > 0),
        "creates_urgent": False,
        "cloud_models": False,
    }


def reasoning_status() -> dict:
    return {
        "mode": REASONING_MODE,
        "cross_source": True,
        "creates_urgent": False,
        "cloud_models": False,
        "mutation_targets": "existing_items_only",
    }

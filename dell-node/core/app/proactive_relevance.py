"""Deterministic local relevance rules for Alfred Phase 4H.

Raw connected-source metadata may be inspected in memory on the Dell, but this
module only returns generic categories, counts and numeric priorities. It never
returns Gmail subjects, snippets or sender identities and makes no model calls.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import re
from typing import Iterable


GMAIL_RELEVANCE_MODE = "deterministic_metadata_v1"


@dataclass(frozen=True)
class GmailCategory:
    key: str
    priority: int
    title_singular: str
    title_plural: str
    summary_singular: str
    summary_plural: str
    phrases: tuple[str, ...]


# Deliberately conservative. No Gmail category reaches the urgent >=90 band,
# so metadata classification alone cannot bypass the normal interruption cooldown.
_GMAIL_CATEGORIES: tuple[GmailCategory, ...] = (
    GmailCategory(
        key="security",
        priority=85,
        title_singular="Account or security email",
        title_plural="Account or security emails",
        summary_singular="1 unread message looks related to account access or security.",
        summary_plural="{count} unread messages look related to account access or security.",
        phrases=(
            "security alert", "unusual sign-in", "unusual sign in", "new sign-in",
            "new sign in", "suspicious activity", "verify your identity",
            "verification code", "one-time code", "one time code", "password reset",
            "account locked", "account access", "fraud alert", "2-step verification",
            "two-step verification",
        ),
    ),
    GmailCategory(
        key="action",
        priority=80,
        title_singular="Action-needed email",
        title_plural="Action-needed emails",
        summary_singular="1 unread message appears to need an action or response.",
        summary_plural="{count} unread messages appear to need an action or response.",
        phrases=(
            "action required", "response required", "please respond", "please reply",
            "approval required", "needs your attention", "complete by", "due by",
            "deadline", "overdue", "final reminder", "urgent action",
        ),
    ),
    GmailCategory(
        key="finance",
        priority=76,
        title_singular="Money or payment email",
        title_plural="Money or payment emails",
        summary_singular="1 unread message looks related to a payment or money matter.",
        summary_plural="{count} unread messages look related to payments or money matters.",
        phrases=(
            "payment failed", "payment due", "card declined", "invoice due",
            "direct debit", "refund", "renewal payment", "payment method",
            "failed payment", "balance due",
        ),
    ),
    GmailCategory(
        key="booking",
        priority=72,
        title_singular="Booking or travel email",
        title_plural="Booking or travel emails",
        summary_singular="1 unread message looks related to a booking, appointment or journey.",
        summary_plural="{count} unread messages look related to bookings, appointments or journeys.",
        phrases=(
            "booking confirmed", "booking confirmation", "reservation confirmed",
            "appointment confirmed", "appointment reminder", "check-in", "check in",
            "boarding pass", "flight", "train ticket", "event ticket", "hotel booking",
        ),
    ),
    GmailCategory(
        key="delivery",
        priority=66,
        title_singular="Delivery email",
        title_plural="Delivery emails",
        summary_singular="1 unread message looks related to a parcel or delivery.",
        summary_plural="{count} unread messages look related to parcels or deliveries.",
        phrases=(
            "out for delivery", "parcel", "delivery update", "delivery today",
            "has been dispatched", "has been shipped", "tracking update", "ready to collect",
        ),
    ),
)


def _normalise(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip().casefold()


def gmail_category(message: dict) -> str | None:
    """Classify one metadata-only Gmail result without returning its content."""
    haystack = " ".join((
        _normalise(message.get("subject")),
        _normalise(message.get("snippet")),
    ))
    if not haystack.strip():
        return None
    for category in _GMAIL_CATEGORIES:
        if any(phrase in haystack for phrase in category.phrases):
            return category.key
    return None


def gmail_relevance(messages: Iterable[dict]) -> dict:
    """Reduce mailbox metadata into content-free aggregate relevance signals."""
    counts: Counter[str] = Counter()
    total = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        total += 1
        key = gmail_category(message)
        if key:
            counts[key] += 1

    categories: list[dict] = []
    for category in _GMAIL_CATEGORIES:
        count = int(counts.get(category.key, 0))
        if count <= 0:
            continue
        categories.append({
            "key": category.key,
            "count": count,
            "priority": category.priority,
            "title": category.title_singular if count == 1 else category.title_plural,
            "summary": (
                category.summary_singular
                if count == 1
                else category.summary_plural.format(count=count)
            ),
        })

    classified = sum(item["count"] for item in categories)
    return {
        "mode": GMAIL_RELEVANCE_MODE,
        "total": total,
        "classified": classified,
        "other": max(0, total - classified),
        "categories": categories,
    }


def task_priority(*, kind: str, days_until_due: int) -> int:
    """Time-sensitive task urgency with bounded deterministic scores."""
    if days_until_due < 0:
        days_overdue = abs(days_until_due)
        if days_overdue >= 7:
            return 98
        if days_overdue >= 3:
            return 96
        return 94
    if days_until_due == 0:
        return 90 if kind == "reminder" else 84
    if days_until_due == 1:
        return 72
    if days_until_due == 2:
        return 60
    return 52


def calendar_priority(*, hours_until_start: float, all_day: bool, same_local_day: bool) -> int:
    """Time-sensitive calendar urgency. Timed events close to start rise fastest."""
    if all_day:
        return 70 if same_local_day else 56
    if hours_until_start <= 0.5:
        return 96
    if hours_until_start <= 2:
        return 90
    if hours_until_start <= 6:
        return 82
    if hours_until_start <= 12:
        return 74
    if hours_until_start <= 24:
        return 66
    return 58


def relevance_status() -> dict:
    return {
        "mode": "deterministic_local",
        "gmail": GMAIL_RELEVANCE_MODE,
        "stores_raw_gmail_metadata": False,
        "cloud_models": False,
    }

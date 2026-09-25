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


GMAIL_RELEVANCE_MODE = "deterministic_metadata_v2"


@dataclass(frozen=True)
class GmailCategory:
    key: str
    priority: int
    title_singular: str
    title_plural: str
    summary_singular: str
    summary_plural: str
    strong_phrases: tuple[str, ...]
    keywords: tuple[str, ...]
    sender_terms: tuple[str, ...] = ()


# Gmail metadata can make an item important, but never urgent. Keeping every
# category below 90 means metadata matching alone cannot bypass cooldown.
_GMAIL_CATEGORIES: tuple[GmailCategory, ...] = (
    GmailCategory(
        key="security",
        priority=85,
        title_singular="Account or security email",
        title_plural="Account or security emails",
        summary_singular="1 unread message looks related to account access or security.",
        summary_plural="{count} unread messages look related to account access or security.",
        strong_phrases=(
            "security alert", "unusual sign-in", "unusual sign in", "new sign-in",
            "new sign in", "new login", "suspicious activity", "verify your identity",
            "verification code", "one-time code", "one time code", "password reset",
            "account locked", "account access", "fraud alert", "2-step verification",
            "two-step verification", "two factor authentication", "login attempt",
            "sign-in attempt", "sign in attempt",
        ),
        keywords=(
            "security", "sign-in", "signin", "login", "password", "verification",
            "authenticate", "authentication", "suspicious", "fraud", "2fa", "otp",
        ),
        sender_terms=("security", "identity", "account"),
    ),
    GmailCategory(
        key="action",
        priority=80,
        title_singular="Action-needed email",
        title_plural="Action-needed emails",
        summary_singular="1 unread message appears to need an action or response.",
        summary_plural="{count} unread messages appear to need an action or response.",
        strong_phrases=(
            "action required", "response required", "please respond", "please reply",
            "approval required", "needs your attention", "complete by", "due by",
            "final reminder", "urgent action", "please review", "please sign",
            "signature required", "confirm your details", "confirm your information",
            "update required", "verify your details",
        ),
        keywords=(
            "deadline", "overdue", "approval", "approve", "respond", "reply",
            "complete", "signature", "sign", "review", "required",
        ),
        sender_terms=("support", "admin"),
    ),
    GmailCategory(
        key="finance",
        priority=76,
        title_singular="Money or payment email",
        title_plural="Money or payment emails",
        summary_singular="1 unread message looks related to a payment or money matter.",
        summary_plural="{count} unread messages look related to payments or money matters.",
        strong_phrases=(
            "payment failed", "payment due", "card declined", "invoice due",
            "direct debit", "renewal payment", "payment method", "failed payment",
            "balance due", "payment received", "payment successful", "payment confirmed",
            "refund issued", "refund processed", "billing update", "amount due",
        ),
        keywords=(
            "payment", "invoice", "billing", "bill", "refund", "charged", "charge",
            "receipt", "subscription", "renewal", "instalment", "installment", "balance",
            "card", "credit", "debit",
        ),
        sender_terms=("billing", "payments", "accounts", "finance"),
    ),
    GmailCategory(
        key="booking",
        priority=72,
        title_singular="Booking or travel email",
        title_plural="Booking or travel emails",
        summary_singular="1 unread message looks related to a booking, appointment or journey.",
        summary_plural="{count} unread messages look related to bookings, appointments or journeys.",
        strong_phrases=(
            "booking confirmed", "booking confirmation", "reservation confirmed",
            "appointment confirmed", "appointment reminder", "check-in", "check in",
            "boarding pass", "train ticket", "event ticket", "hotel booking",
            "booking details", "reservation details", "travel details", "journey details",
        ),
        keywords=(
            "booking", "reservation", "appointment", "flight", "hotel", "ticket",
            "boarding", "travel", "journey", "train", "event",
        ),
        sender_terms=("booking", "reservations", "travel", "tickets"),
    ),
    GmailCategory(
        key="delivery",
        priority=66,
        title_singular="Delivery email",
        title_plural="Delivery emails",
        summary_singular="1 unread message looks related to a parcel or delivery.",
        summary_plural="{count} unread messages look related to parcels or deliveries.",
        strong_phrases=(
            "out for delivery", "delivery update", "delivery today", "has been dispatched",
            "has been shipped", "tracking update", "ready to collect", "on its way",
            "your parcel", "your package", "delivery attempt", "delivered today",
        ),
        keywords=(
            "delivery", "parcel", "package", "dispatch", "dispatched", "shipped",
            "shipping", "tracking", "courier", "delivered", "collection",
        ),
        sender_terms=("delivery", "tracking", "courier", "dispatch"),
    ),
)


def _normalise(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip().casefold()


def _contains_term(text: str, term: str) -> bool:
    """Match phrases or token-like terms without leaking source text."""
    clean = term.casefold().strip()
    if not clean:
        return False
    if any(char in clean for char in (" ", "-")):
        return clean in text
    return re.search(rf"(?<![a-z0-9]){re.escape(clean)}(?![a-z0-9])", text) is not None


def _category_score(category: GmailCategory, *, subject: str, snippet: str, sender: str) -> int:
    body = f"{subject} {snippet}".strip()
    score = 0

    # Exact multi-word signals carry the most weight.
    if any(phrase in body for phrase in category.strong_phrases):
        score += 4

    # A category keyword in the subject is stronger than the same word in a
    # snippet because subjects are normally the sender's explicit intent label.
    if any(_contains_term(subject, term) for term in category.keywords):
        score += 3
    elif any(_contains_term(snippet, term) for term in category.keywords):
        score += 2

    # Sender metadata is only a supporting signal and never enough by itself.
    if any(_contains_term(sender, term) for term in category.sender_terms):
        score += 1

    return score


def gmail_category(message: dict) -> str | None:
    """Classify one metadata-only Gmail result without returning its content."""
    subject = _normalise(message.get("subject"))
    snippet = _normalise(message.get("snippet"))
    sender = _normalise(message.get("from"))
    if not (subject or snippet or sender):
        return None

    scored = [
        (_category_score(category, subject=subject, snippet=snippet, sender=sender), category)
        for category in _GMAIL_CATEGORIES
    ]
    best_score, best = max(scored, key=lambda pair: (pair[0], pair[1].priority))

    # Two points means a meaningful snippet keyword; three points means a
    # subject keyword. A sender/domain hint alone scores only one and is ignored.
    return best.key if best_score >= 2 else None


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

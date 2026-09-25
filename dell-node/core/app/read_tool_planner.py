"""Deterministic natural-language planning for safe read-only integrations.

This planner deliberately handles only a narrow set of read intents. It cannot
plan writes, cannot invent tool names, and cannot override Core policy. Every
plan is revalidated against the registered tool policy before it is returned.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, time, timedelta
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import config
from .core import TOOLS, decide
from .integrations import action_owner


MUTATION_RE = re.compile(
    r"\b(add|create|delete|remove|cancel|reschedule|move|change|update|edit|send|reply|forward|archive|mark)\b",
    re.IGNORECASE,
)
ENTITY_RE = re.compile(r"\b([a-z_]+\.[A-Za-z0-9_]+)\b")
EMAIL_RE = re.compile(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b")
MESSAGE_ID_RE = re.compile(r"\b(?:message|email)\s+(?:id\s+)?([A-Za-z0-9_-]{6,256})\b", re.IGNORECASE)


@dataclass(frozen=True)
class ReadToolPlan:
    action: str
    arguments: dict
    integration: str
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def _timezone() -> ZoneInfo:
    try:
        return ZoneInfo(config.settings.timezone)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _local_now(now: datetime | None = None) -> datetime:
    zone = _timezone()
    if now is None:
        return datetime.now(zone)
    if now.tzinfo is None or now.utcoffset() is None:
        return now.replace(tzinfo=zone)
    return now.astimezone(zone)


def _calendar_window(message: str, now: datetime | None = None) -> tuple[str, str]:
    local = _local_now(now)
    start_today = datetime.combine(local.date(), time.min, tzinfo=local.tzinfo)
    lowered = message.casefold()
    if "tomorrow" in lowered:
        start = start_today + timedelta(days=1)
        end = start + timedelta(days=1)
    elif "today" in lowered:
        start = start_today
        end = start + timedelta(days=1)
    elif "week" in lowered or "next 7 days" in lowered:
        start = start_today
        end = start + timedelta(days=7)
    else:
        start = start_today
        end = start + timedelta(days=7)
    return start.isoformat(), end.isoformat()


def _email_query(message: str) -> str:
    lowered = message.casefold()
    parts: list[str] = []
    if "unread" in lowered:
        parts.append("is:unread")
    from_match = re.search(r"\bfrom\s+([^\s]+@[^\s]+)\b", message, re.IGNORECASE)
    if from_match:
        parts.append(f"from:{from_match.group(1).rstrip('.,;')}")
    subject_match = re.search(r"\bsubject\s+(?:is\s+|contains\s+)?(.+)$", message, re.IGNORECASE)
    if subject_match:
        subject = subject_match.group(1).strip(" .?")[:160]
        if subject:
            parts.append(f"subject:{subject}")
    about_match = re.search(r"\b(?:about|for)\s+(.+)$", message, re.IGNORECASE)
    if about_match and not subject_match:
        term = about_match.group(1).strip(" .?")[:200]
        if term and not EMAIL_RE.fullmatch(term):
            parts.append(term)
    if not parts:
        parts.append("in:inbox")
    return " ".join(parts)[:500]


def _validated(action: str, arguments: dict, reason: str) -> ReadToolPlan | None:
    definition = TOOLS.get(action)
    if not definition:
        return None
    policy = decide(action)
    if policy.level != "read" or policy.decision != "auto":
        return None
    return ReadToolPlan(
        action=action,
        arguments=arguments,
        integration=action_owner(action),
        reason=reason,
    )


def plan_read_tool(message: str, *, now: datetime | None = None) -> ReadToolPlan | None:
    """Return one conservative read-only plan, or None when intent is ambiguous."""
    if not isinstance(message, str) or not message.strip():
        return None
    clean = message.strip()[:4000]
    lowered = clean.casefold()

    # Never reinterpret an apparent mutation request as a read.
    if MUTATION_RE.search(clean):
        return None

    if any(term in lowered for term in ("calendar", "my schedule", "appointments", "appointment")):
        start, end = _calendar_window(clean, now)
        return _validated(
            "calendar.events.list",
            {"start": start, "end": end, "limit": 20},
            "Read a bounded Calendar window.",
        )

    if any(term in lowered for term in ("gmail", "inbox", "email", "emails")):
        message_match = MESSAGE_ID_RE.search(clean)
        if message_match and any(term in lowered for term in ("open", "read", "show")):
            return _validated(
                "email.message.get",
                {"message_id": message_match.group(1)},
                "Read one explicitly identified Gmail message.",
            )
        return _validated(
            "email.messages.search",
            {"query": _email_query(clean), "limit": 10},
            "Search Gmail with a bounded query.",
        )

    if any(term in lowered for term in ("my tasks", "tasks", "reminders", "to-do", "todo")):
        kind = None
        if "reminder" in lowered and "task" not in lowered:
            kind = "reminder"
        elif "task" in lowered and "reminder" not in lowered:
            kind = "task"
        arguments = {"include_completed": any(term in lowered for term in ("completed", "done")), "limit": 50}
        if kind is not None:
            arguments["kind"] = kind
        return _validated("tasks.list", arguments, "Read local tasks and reminders.")

    entity = ENTITY_RE.search(clean)
    if entity and any(term in lowered for term in ("home assistant", "state", "status", "is the", "is my")):
        return _validated(
            "home_assistant.state",
            {"entity_id": entity.group(1)},
            "Read one explicitly identified Home Assistant entity.",
        )

    return None


def sources_for_result(action: str, result: dict) -> list[dict]:
    if action == "calendar.events.list":
        events = result.get("events")
        return events if isinstance(events, list) else []
    if action == "email.messages.search":
        messages = result.get("messages")
        return messages if isinstance(messages, list) else []
    if action == "email.message.get":
        message = result.get("message")
        return [message] if isinstance(message, dict) else []
    if action == "tasks.list":
        items = result.get("items")
        return items if isinstance(items, list) else []
    if action == "home_assistant.state":
        return [result] if isinstance(result, dict) else []
    return []


def render_result(action: str, result: dict) -> str:
    """Render verified read results without asking a model to reinterpret them."""
    if action == "calendar.events.list":
        events = result.get("events") if isinstance(result.get("events"), list) else []
        if not events:
            return "I found no calendar events in that time window."
        labels = [f"{event.get('summary', '(untitled)')} — {event.get('start', '')}" for event in events[:8]]
        return f"I found {len(events)} calendar event{'s' if len(events) != 1 else ''}: " + "; ".join(labels) + "."

    if action == "email.messages.search":
        messages = result.get("messages") if isinstance(result.get("messages"), list) else []
        if not messages:
            return "I found no matching emails."
        labels = [
            f"{item.get('from', 'Unknown sender')} — {item.get('subject', '(no subject)')} — {item.get('snippet', '')[:180]}"
            for item in messages[:6]
        ]
        return f"I found {len(messages)} matching email{'s' if len(messages) != 1 else ''}: " + "; ".join(labels) + "."

    if action == "email.message.get":
        item = result.get("message") if isinstance(result.get("message"), dict) else {}
        body = str(item.get("body", ""))[:1800]
        return f"{item.get('subject', '(no subject)')} from {item.get('from', 'Unknown sender')}: {body}"

    if action == "tasks.list":
        items = result.get("items") if isinstance(result.get("items"), list) else []
        if not items:
            return "I found no matching tasks or reminders."
        labels = [
            f"{item.get('title', '(untitled)')}{' — ' + item['due'] if item.get('due') else ''}"
            for item in items[:10]
        ]
        return f"I found {len(items)} item{'s' if len(items) != 1 else ''}: " + "; ".join(labels) + "."

    if action == "home_assistant.state":
        return f"{result.get('entity_id', 'The entity')} is {result.get('state', 'unknown')}."

    return "The tool completed successfully."

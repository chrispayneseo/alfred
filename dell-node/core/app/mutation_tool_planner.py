"""Deterministic mutation proposal planner for Alfred Core.

This planner only emits registered write/action tools when all required arguments
are explicitly present in the user's message. It never confirms an action and
never executes around Core approval policy.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

from .core import TOOLS, decide
from .integrations import action_owner
from .read_tool_planner import _calendar_window
from . import google_calendar


ENTITY_RE = re.compile(r"\b([a-z_]+\.[A-Za-z0-9_]+)\b")
EMAIL_ADDRESS_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
TASK_RE = re.compile(r"^\s*(?:add|create)\s+(?:a\s+)?task\s*:\s*(.+?)\s*$", re.IGNORECASE)
REMINDER_RE = re.compile(
    r"^\s*(?:add|create)\s+(?:a\s+)?reminder\s*:\s*(.+?)\s+due\s+(\d{4}-\d{2}-\d{2})\s*$",
    re.IGNORECASE,
)
CALENDAR_RE = re.compile(
    r"^\s*(?:add|create)\s+(?:a\s+)?(?:calendar\s+)?event\s*:\s*(.+?)\s+from\s+"
    r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))\s+to\s+"
    r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))\s*$",
    re.IGNORECASE,
)
EMAIL_DRAFT_RE = re.compile(
    r"^\s*(?:create|make)\s+(?:an?\s+)?email\s+draft\s+to\s+(\S+)\s+"
    r"subject\s*:\s*(.+?)\s+body\s*:\s*(.+?)\s*$",
    re.IGNORECASE | re.DOTALL,
)
HA_RE = re.compile(r"^\s*turn\s+(on|off)\s+([a-z_]+\.[A-Za-z0-9_]+)\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class MutationToolPlan:
    action: str
    arguments: dict
    integration: str
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def _validated(action: str, arguments: dict, reason: str) -> MutationToolPlan | None:
    definition = TOOLS.get(action)
    if not definition:
        return None
    policy = decide(action)
    if policy.decision not in {"auto", "confirm"} or policy.level not in {"safe_write", "reversible", "external"}:
        return None
    return MutationToolPlan(
        action=action,
        arguments=arguments,
        integration=action_owner(action),
        reason=reason,
    )



CALENDAR_DELETE_RE = re.compile(
    r"^\s*(?:delete|remove|cancel)\s+(?:the\s+)?(.+?)"
    r"(?:\s+event)?\s+from\s+(?:my\s+)?calendar(?:\s+(today|tomorrow))?\s*[?.]*$",
    re.IGNORECASE,
)


async def resolve_calendar_mutation(message: str) -> MutationToolPlan | None:
    """Resolve a natural-language Calendar mutation to one exact existing event.

    Resolution is deliberately fail-closed: zero or multiple exact title matches
    produce no mutation plan. The returned mutation still passes through Core's
    normal approval, execution and verification path.
    """
    if not isinstance(message, str) or not message.strip():
        return None

    clean = message.strip()[:4000]
    match = CALENDAR_DELETE_RE.fullmatch(clean)
    if not match:
        return None

    requested_title = match.group(1).strip()
    day_hint = match.group(2)

    # Avoid treating a trailing "event" as part of the title.
    requested_title = re.sub(r"\s+event$", "", requested_title, flags=re.IGNORECASE).strip()
    if not requested_title:
        return None

    window_message = day_hint or clean
    start, end = _calendar_window(window_message)
    result = await google_calendar.list_events(start, end, 20)
    events = result.get("events") if isinstance(result, dict) else None
    if not isinstance(events, list):
        return None

    wanted = requested_title.casefold()
    matches = [
        event for event in events
        if isinstance(event, dict)
        and isinstance(event.get("summary"), str)
        and event["summary"].strip().casefold() == wanted
        and isinstance(event.get("id"), str)
        and event["id"]
    ]

    if len(matches) != 1:
        return None

    event = matches[0]
    return _validated(
        "calendar.events.delete",
        {"event_id": event["id"]},
        f"Delete the uniquely resolved Calendar event '{event['summary']}' after owner confirmation.",
    )

def plan_mutation_tool(message: str) -> MutationToolPlan | None:
    """Return one exact mutation proposal or None when required data is absent."""
    if not isinstance(message, str) or not message.strip():
        return None
    clean = message.strip()[:4000]

    reminder = REMINDER_RE.fullmatch(clean)
    if reminder:
        title = reminder.group(1).strip()
        due = reminder.group(2)
        if not title:
            return None
        return _validated(
            "tasks.create",
            {"kind": "reminder", "title": title[:300], "due": due, "detail": ""},
            "Create the explicitly requested reminder after owner confirmation.",
        )

    task = TASK_RE.fullmatch(clean)
    if task:
        title = task.group(1).strip()
        if not title:
            return None
        return _validated(
            "tasks.create",
            {"kind": "task", "title": title[:300], "due": None, "detail": ""},
            "Create the explicitly requested task after owner confirmation.",
        )

    event = CALENDAR_RE.fullmatch(clean)
    if event:
        summary = event.group(1).strip()
        if not summary:
            return None
        return _validated(
            "calendar.events.create",
            {"summary": summary[:500], "start": event.group(2), "end": event.group(3)},
            "Create the explicitly specified routine Calendar event.",
        )

    draft = EMAIL_DRAFT_RE.fullmatch(clean)
    if draft:
        recipient = draft.group(1).strip()
        subject = draft.group(2).strip()
        body = draft.group(3).strip()
        if (
            not EMAIL_ADDRESS_RE.fullmatch(recipient)
            or not subject
            or "\r" in subject
            or "\n" in subject
            or not body
        ):
            return None
        return _validated(
            "email.draft.create",
            {"to": recipient[:320], "subject": subject[:300], "body": body[:10000]},
            "Create the explicitly specified Gmail draft after owner confirmation.",
        )

    home = HA_RE.fullmatch(clean)
    if home:
        state = home.group(1).casefold()
        entity_id = home.group(2)
        domain = entity_id.split(".", 1)[0]
        if domain not in {"light", "switch", "fan", "input_boolean"}:
            return None
        return _validated(
            "home_assistant.service",
            {"service": f"{domain}.turn_{state}", "entity_id": entity_id},
            "Change the explicitly identified Home Assistant entity after owner confirmation.",
        )

    return None

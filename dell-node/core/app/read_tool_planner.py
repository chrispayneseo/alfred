"""Deterministic natural-language planning for safe read-only integrations.

This planner deliberately handles only a narrow set of read intents. It cannot
plan writes, cannot invent tool names, and cannot override Core policy. Every
plan is revalidated against the registered tool policy before it is returned.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, time, timedelta
import calendar
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
FILE_READ_RE = re.compile(
    r"^\s*(?:read|open|show)(?:\s+me)?(?:\s+my)?\s+file\s*:\s*(.+?)\s*$",
    re.IGNORECASE,
)
FILE_LIST_RE = re.compile(
    r"^\s*(?:list|show)(?:\s+me)?(?:\s+my)?\s+files(?:\s+in\s+(.+?))?\s*[?.]*\s*$",
    re.IGNORECASE,
)
FILE_SEARCH_IN_RE = re.compile(
    r"^\s*search(?:\s+my)?\s+files\s+in\s+(.+?)\s+for\s+(.+?)\s*[?.]*\s*$",
    re.IGNORECASE,
)
FILE_SEARCH_RE = re.compile(
    r"^\s*search(?:\s+my)?\s+files\s+for\s+(.+?)\s*[?.]*\s*$",
    re.IGNORECASE,
)
FILE_FIND_RE = re.compile(
    r"^\s*find\s+(.+?)\s+in\s+(?:my\s+)?files\s*[?.]*\s*$",
    re.IGNORECASE,
)


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
    month_names = {name.casefold(): index for index, name in enumerate(calendar.month_name) if name}
    named_month = next(((name, index) for name, index in month_names.items()
                        if re.search(rf"\\b{name}\\b", lowered)), None)
    if named_month is not None:
        month = named_month[1]
        year_match = re.search(r"\\b(20\\d{2})\\b", lowered)
        year = int(year_match.group(1)) if year_match else (local.year if month >= local.month else local.year + 1)
        start = datetime(year, month, 1, tzinfo=local.tzinfo)
        end = datetime(year + 1, 1, 1, tzinfo=local.tzinfo) if month == 12 else datetime(year, month + 1, 1, tzinfo=local.tzinfo)
    elif "tomorrow" in lowered:
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


def _file_plan(clean: str) -> ReadToolPlan | None:
    read_match = FILE_READ_RE.fullmatch(clean)
    if read_match:
        path = read_match.group(1).strip(" \t?.")
        if path:
            return _validated(
                "files.read",
                {"path": path[:500], "max_chars": 12000},
                "Read one explicitly identified text file inside Alfred's sandbox.",
            )

    search_in = FILE_SEARCH_IN_RE.fullmatch(clean)
    if search_in:
        path = search_in.group(1).strip(" \t?.")
        query = search_in.group(2).strip(" \t?.")
        if path and len(query) >= 2:
            return _validated(
                "files.search",
                {"query": query[:200], "path": path[:500], "limit": 10},
                "Search a bounded folder inside Alfred's file sandbox.",
            )

    search = FILE_SEARCH_RE.fullmatch(clean)
    if search:
        query = search.group(1).strip(" \t?.")
        if len(query) >= 2:
            return _validated(
                "files.search",
                {"query": query[:200], "path": ".", "limit": 10},
                "Search text files inside Alfred's file sandbox.",
            )

    find = FILE_FIND_RE.fullmatch(clean)
    if find:
        query = find.group(1).strip(" \t?.")
        if len(query) >= 2:
            return _validated(
                "files.search",
                {"query": query[:200], "path": ".", "limit": 10},
                "Search text files inside Alfred's file sandbox.",
            )

    listing = FILE_LIST_RE.fullmatch(clean)
    if listing:
        path = (listing.group(1) or ".").strip(" \t?.") or "."
        return _validated(
            "files.list",
            {"path": path[:500], "limit": 50},
            "List visible files inside Alfred's file sandbox.",
        )
    return None


def plan_read_tool(message: str, *, now: datetime | None = None) -> ReadToolPlan | None:
    """Return one conservative read-only plan, or None when intent is ambiguous."""
    if not isinstance(message, str) or not message.strip():
        return None
    clean = message.strip()[:4000]
    lowered = clean.casefold()

    # Never reinterpret an apparent mutation request as a read.
    if MUTATION_RE.search(clean):
        return None

    file_plan = _file_plan(clean)
    if file_plan is not None:
        return file_plan

    if any(term in lowered for term in ("calendar", "my schedule", "appointments", "appointment", "gigs", "gig", "concerts", "concert", "events", "bookings", "booking")):
        start, end = _calendar_window(clean, now)
        return _validated(
            "calendar.events.list",
            {"start": start, "end": end, "limit": 20},
            "Read a bounded Calendar window.",
        )

    if any(term in lowered for term in ("github", "repositories", "repos")):
        repo_match = re.search(r"\\b([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)\\b", clean)
        if repo_match and any(term in lowered for term in ("repo", "repository", "about", "status", "details")):
            return _validated("github.repo.get", {"full_name": repo_match.group(1)}, "Read repository metadata from GitHub.")
        return _validated("github.repos.list", {"limit": 100}, "List repositories available to Alfred's GitHub account token.")

    if "vercel" in lowered or "vercel projects" in lowered:
        return _validated("vercel.projects.list", {"limit": 100}, "List projects available to Alfred's Vercel account token.")

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
    if action == "github.repos.list":
        items = result.get("repos")
        return items if isinstance(items, list) else []
    if action == "github.repo.get":
        item = result.get("repo")
        return [item] if isinstance(item, dict) else []
    if action == "vercel.projects.list":
        items = result.get("projects")
        return items if isinstance(items, list) else []
    if action == "vercel.deployments.list":
        items = result.get("deployments")
        return items if isinstance(items, list) else []
    if action == "github.repos.list":
        items = result.get("repos") if isinstance(result.get("repos"), list) else []
        labels = [item.get("full_name", item.get("name", "(unnamed)")) for item in items[:20]]
        return f"I found {len(items)} GitHub repositor{'ies' if len(items) != 1 else 'y'}: " + "; ".join(labels) + "."
    if action == "github.repo.get":
        item = result.get("repo") if isinstance(result.get("repo"), dict) else {}
        return f"{item.get('full_name', 'Repository')}: default branch {item.get('default_branch', 'unknown')}, {item.get('open_issues_count', 0)} open issues, updated {item.get('updated_at', 'unknown')}."
    if action == "vercel.projects.list":
        items = result.get("projects") if isinstance(result.get("projects"), list) else []
        labels = [item.get("name", "(unnamed)") for item in items[:20]]
        return f"I found {len(items)} Vercel project{'s' if len(items) != 1 else ''}: " + "; ".join(labels) + "."
    if action == "vercel.deployments.list":
        items = result.get("deployments") if isinstance(result.get("deployments"), list) else []
        labels = [f"{item.get('name','deployment')} — {item.get('state','unknown')}" for item in items[:20]]
        return f"I found {len(items)} Vercel deployment{'s' if len(items) != 1 else ''}: " + "; ".join(labels) + "."
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
    if action == "files.list":
        items = result.get("items")
        return items if isinstance(items, list) else []
    if action == "files.search":
        items = result.get("results")
        return items if isinstance(items, list) else []
    if action == "files.read":
        if not isinstance(result, dict):
            return []
        return [{
            "path": result.get("path", ""),
            "content": str(result.get("content", ""))[:4000],
            "truncated": bool(result.get("truncated")),
        }]
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

    if action == "files.list":
        items = result.get("items") if isinstance(result.get("items"), list) else []
        if not items:
            return "I found no visible files or folders there."
        labels = [
            f"{item.get('name', '(unnamed)')}{'/' if item.get('kind') == 'folder' else ''}"
            for item in items[:20]
        ]
        return f"I found {len(items)} visible item{'s' if len(items) != 1 else ''}: " + "; ".join(labels) + "."

    if action == "files.search":
        matches = result.get("results") if isinstance(result.get("results"), list) else []
        if not matches:
            return "I found no matching text in the file sandbox."
        labels = []
        for item in matches[:8]:
            location = str(item.get("path", ""))
            if isinstance(item.get("line"), int):
                location += f":{item['line']}"
            excerpt = str(item.get("excerpt", ""))[:180]
            labels.append(f"{location} — {excerpt}" if excerpt else location)
        return f"I found {len(matches)} file match{'es' if len(matches) != 1 else ''}: " + "; ".join(labels) + "."

    if action == "files.read":
        path = str(result.get("path", "file"))
        content = str(result.get("content", ""))[:12000]
        suffix = "\n\n[File was truncated by the read limit.]" if result.get("truncated") else ""
        return f"{path}:\n{content}{suffix}"

    return "The tool completed successfully."

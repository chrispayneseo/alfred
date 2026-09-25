"""Executable adapter registry for Alfred integrations.

Core policy decides whether an action may run. This module only maps already
registered integration actions to their implementation and deterministic
verification. Adding an integration therefore requires three explicit pieces:
Core policy, a capability manifest, and an adapter here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable

from .clients import home_assistant, home_assistant_state
from .gmail import get_message as gmail_get_message, search_messages as gmail_search_messages
from .google_calendar import (
    create_event as google_calendar_create_event,
    delete_event as google_calendar_delete_event,
    list_events as google_calendar_list_events,
    update_event as google_calendar_update_event,
)
from .local_files import (
    list_directory as local_files_list_directory,
    read_file as local_files_read_file,
    search_files as local_files_search_files,
)
from . import task_service


Invoke = Callable[[dict, str], Awaitable[dict]]
Verify = Callable[[dict], dict]


@dataclass(frozen=True)
class Adapter:
    action: str
    invoke: Invoke
    verify: Verify


def _require(arguments: dict, name: str, expected_type: type | tuple[type, ...] = str):
    value = arguments.get(name)
    if not isinstance(value, expected_type) or (isinstance(value, str) and not value.strip()):
        raise ValueError(f"Missing or invalid argument: {name}")
    return value


async def _tasks_list(arguments: dict, _: str) -> dict:
    kind = arguments.get("kind")
    include_completed = arguments.get("include_completed", False)
    limit = arguments.get("limit", 50)
    if kind is not None and not isinstance(kind, str):
        raise ValueError("Missing or invalid argument: kind")
    if not isinstance(include_completed, bool):
        raise ValueError("Missing or invalid argument: include_completed")
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise ValueError("Missing or invalid argument: limit")
    return {"items": task_service.list_items(kind=kind, include_completed=include_completed, limit=limit)}


async def _tasks_create(arguments: dict, _: str) -> dict:
    kind = _require(arguments, "kind")
    title = _require(arguments, "title")
    due = arguments.get("due")
    detail = arguments.get("detail", "")
    if due is not None and not isinstance(due, str):
        raise ValueError("Missing or invalid argument: due")
    if not isinstance(detail, str):
        raise ValueError("Missing or invalid argument: detail")
    return {"item": task_service.create(kind=kind, title=title, due=due, detail=detail)}


async def _tasks_update(arguments: dict, _: str) -> dict:
    source_id = _require(arguments, "source_id")
    title = _require(arguments, "title")
    due = arguments.get("due")
    detail = arguments.get("detail", "")
    if due is not None and not isinstance(due, str):
        raise ValueError("Missing or invalid argument: due")
    if not isinstance(detail, str):
        raise ValueError("Missing or invalid argument: detail")
    return {"item": task_service.update(source_id, title=title, due=due, detail=detail)}


async def _tasks_complete(arguments: dict, _: str) -> dict:
    source_id = _require(arguments, "source_id")
    completed = arguments.get("completed")
    if not isinstance(completed, bool):
        raise ValueError("Missing or invalid argument: completed")
    return {"item": task_service.set_completed(source_id, completed)}


async def _tasks_delete(arguments: dict, _: str) -> dict:
    source_id = _require(arguments, "source_id")
    if not task_service.delete(source_id):
        raise LookupError("Task or reminder not found")
    return {"source_id": source_id}


async def _ha_state(arguments: dict, _: str) -> dict:
    return await home_assistant_state(_require(arguments, "entity_id"))


async def _ha_service(arguments: dict, _: str) -> dict:
    service = _require(arguments, "service")
    entity_id = _require(arguments, "entity_id")
    return await home_assistant(service, entity_id)


async def _files_list(arguments: dict, _: str) -> dict:
    path = arguments.get("path", ".")
    limit = arguments.get("limit", 50)
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Missing or invalid argument: path")
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise ValueError("Missing or invalid argument: limit")
    return local_files_list_directory(path, limit)


async def _files_search(arguments: dict, _: str) -> dict:
    query = _require(arguments, "query")
    path = arguments.get("path", ".")
    limit = arguments.get("limit", 10)
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Missing or invalid argument: path")
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise ValueError("Missing or invalid argument: limit")
    return local_files_search_files(query, path, limit)


async def _files_read(arguments: dict, _: str) -> dict:
    path = _require(arguments, "path")
    max_chars = arguments.get("max_chars", 12000)
    if not isinstance(max_chars, int) or isinstance(max_chars, bool):
        raise ValueError("Missing or invalid argument: max_chars")
    return local_files_read_file(path, max_chars)


async def _calendar_list(arguments: dict, _: str) -> dict:
    start = _require(arguments, "start")
    end = _require(arguments, "end")
    limit = arguments.get("limit", 20)
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise ValueError("Missing or invalid argument: limit")
    return await google_calendar_list_events(start, end, limit)


async def _calendar_create(arguments: dict, _: str) -> dict:
    return await google_calendar_create_event(
        _require(arguments, "summary"), _require(arguments, "start"), _require(arguments, "end")
    )


async def _calendar_update(arguments: dict, _: str) -> dict:
    return await google_calendar_update_event(
        _require(arguments, "event_id"), _require(arguments, "summary"),
        _require(arguments, "start"), _require(arguments, "end")
    )


async def _calendar_delete(arguments: dict, _: str) -> dict:
    return await google_calendar_delete_event(_require(arguments, "event_id"))


async def _gmail_search(arguments: dict, _: str) -> dict:
    query = _require(arguments, "query")
    limit = arguments.get("limit", 10)
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise ValueError("Missing or invalid argument: limit")
    return await gmail_search_messages(query, limit)


async def _gmail_get(arguments: dict, _: str) -> dict:
    return await gmail_get_message(_require(arguments, "message_id"))


def _verify_task_list(result: dict) -> dict:
    items = result.get("items")
    ok = isinstance(items, list) and all(
        isinstance(item, dict)
        and isinstance(item.get("source_id"), str)
        and item.get("kind") in {"task", "reminder"}
        and isinstance(item.get("title"), str)
        and isinstance(item.get("completed"), bool)
        for item in items
    )
    return {"ok": ok, "method": "task_list", "item_count": len(items) if isinstance(items, list) else 0}


def _verify_stored_task(result: dict) -> dict:
    item = result.get("item")
    source_id = item.get("source_id") if isinstance(item, dict) else None
    stored = task_service.get(source_id) if isinstance(source_id, str) else None
    ok = bool(stored) and all(stored.get(key) == item.get(key) for key in ("source_id", "kind", "title", "due", "detail", "completed"))
    return {"ok": ok, "method": "stored_task", "source_id": source_id}


def _verify_task_state(result: dict) -> dict:
    item = result.get("item")
    source_id = item.get("source_id") if isinstance(item, dict) else None
    stored = task_service.get(source_id) if isinstance(source_id, str) else None
    ok = bool(stored) and stored.get("completed") == item.get("completed")
    return {"ok": ok, "method": "task_state", "source_id": source_id}


def _verify_task_absent(result: dict) -> dict:
    source_id = result.get("source_id")
    ok = isinstance(source_id, str) and task_service.get(source_id) is None
    return {"ok": ok, "method": "task_absent", "source_id": source_id}


def _verify_ha_state(result: dict) -> dict:
    ok = result.get("ok") is True and isinstance(result.get("entity_id"), str) and isinstance(result.get("state"), str) and isinstance(result.get("attributes"), dict)
    return {"ok": ok, "method": "device_state", "entity_id": result.get("entity_id")}


def _verify_ha_service(result: dict) -> dict:
    return {"ok": result.get("ok") is True, "method": "service_response"}


def _verify_file_list(result: dict) -> dict:
    items = result.get("items")
    ok = result.get("ok") is True and result.get("read_only") is True and isinstance(items, list)
    if ok:
        ok = all(
            isinstance(item, dict)
            and isinstance(item.get("name"), str)
            and isinstance(item.get("path"), str)
            and item.get("kind") in {"file", "folder"}
            and (item.get("size") is None or isinstance(item.get("size"), int))
            for item in items
        )
    return {"ok": ok, "method": "file_list", "item_count": len(items) if isinstance(items, list) else 0}


def _verify_file_search(result: dict) -> dict:
    results = result.get("results")
    ok = (
        result.get("ok") is True
        and result.get("read_only") is True
        and isinstance(result.get("query"), str)
        and isinstance(results, list)
    )
    if ok:
        ok = all(
            isinstance(item, dict)
            and isinstance(item.get("path"), str)
            and (item.get("line") is None or isinstance(item.get("line"), int))
            and isinstance(item.get("excerpt"), str)
            for item in results
        )
    return {"ok": ok, "method": "file_search", "match_count": len(results) if isinstance(results, list) else 0}


def _verify_file_content(result: dict) -> dict:
    ok = (
        result.get("ok") is True
        and result.get("read_only") is True
        and isinstance(result.get("path"), str)
        and isinstance(result.get("content"), str)
        and isinstance(result.get("size"), int)
        and isinstance(result.get("truncated"), bool)
    )
    return {"ok": ok, "method": "file_content", "path": result.get("path")}


def _valid_event(event: object) -> bool:
    return isinstance(event, dict) and all(isinstance(event.get(key), str) for key in ("id", "summary", "start", "end", "status")) and isinstance(event.get("all_day"), bool)


def _verify_calendar_list(result: dict) -> dict:
    events = result.get("events")
    window = result.get("window")
    ok = result.get("ok") is True and isinstance(events, list) and isinstance(window, dict)
    if ok:
        ok = all(_valid_event(event) for event in events)
    return {"ok": ok, "method": "calendar_events", "event_count": len(events) if isinstance(events, list) else 0}


def _verify_calendar_event(result: dict) -> dict:
    event = result.get("event")
    ok = result.get("ok") is True and _valid_event(event)
    return {"ok": ok, "method": "calendar_event", "event_id": event.get("id") if isinstance(event, dict) else None}


def _verify_calendar_deleted(result: dict) -> dict:
    event_id = result.get("event_id")
    ok = result.get("ok") is True and result.get("deleted") is True and isinstance(event_id, str) and bool(event_id)
    return {"ok": ok, "method": "calendar_event_deleted", "event_id": event_id}


def _valid_email_summary(message: object, *, body_required: bool = False) -> bool:
    if not isinstance(message, dict):
        return False
    required = ("id", "thread_id", "from", "to", "subject", "date", "snippet")
    if not all(isinstance(message.get(key), str) for key in required):
        return False
    if not isinstance(message.get("unread"), bool):
        return False
    if body_required and not isinstance(message.get("body"), str):
        return False
    return True


def _verify_email_search(result: dict) -> dict:
    messages = result.get("messages")
    count = result.get("count")
    ok = result.get("ok") is True and isinstance(messages, list) and isinstance(count, int)
    if ok:
        ok = count == len(messages) and all(_valid_email_summary(message) for message in messages)
    return {"ok": ok, "method": "email_search", "message_count": len(messages) if isinstance(messages, list) else 0}


def _verify_email_message(result: dict) -> dict:
    message = result.get("message")
    ok = result.get("ok") is True and _valid_email_summary(message, body_required=True)
    return {"ok": ok, "method": "email_message", "message_id": message.get("id") if isinstance(message, dict) else None}


ADAPTERS: dict[str, Adapter] = {
    adapter.action: adapter for adapter in (
        Adapter("tasks.list", _tasks_list, _verify_task_list),
        Adapter("tasks.create", _tasks_create, _verify_stored_task),
        Adapter("tasks.update", _tasks_update, _verify_stored_task),
        Adapter("tasks.complete", _tasks_complete, _verify_task_state),
        Adapter("tasks.delete", _tasks_delete, _verify_task_absent),
        Adapter("home_assistant.state", _ha_state, _verify_ha_state),
        Adapter("home_assistant.service", _ha_service, _verify_ha_service),
        Adapter("files.list", _files_list, _verify_file_list),
        Adapter("files.search", _files_search, _verify_file_search),
        Adapter("files.read", _files_read, _verify_file_content),
        Adapter("calendar.events.list", _calendar_list, _verify_calendar_list),
        Adapter("calendar.events.create", _calendar_create, _verify_calendar_event),
        Adapter("calendar.events.update", _calendar_update, _verify_calendar_event),
        Adapter("calendar.events.delete", _calendar_delete, _verify_calendar_deleted),
        Adapter("email.messages.search", _gmail_search, _verify_email_search),
        Adapter("email.message.get", _gmail_get, _verify_email_message),
    )
}


def registered_actions() -> set[str]:
    return set(ADAPTERS)


async def invoke(action: str, arguments: dict, request_id: str) -> dict | None:
    adapter = ADAPTERS.get(action)
    if adapter is None:
        return None
    return await adapter.invoke(arguments, request_id)


def verify(action: str, result: dict) -> dict | None:
    adapter = ADAPTERS.get(action)
    if adapter is None:
        return None
    return adapter.verify(result)

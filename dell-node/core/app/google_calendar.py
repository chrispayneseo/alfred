"""Minimal Google Calendar adapter for Alfred Core.

OAuth refresh credentials remain in the Dell environment. Event responses are
intentionally data-minimised before they cross the integration boundary into
Core: descriptions, attendees, conferencing data and arbitrary properties are
not returned. Calendar writes require an explicit Core-side feature gate and
exact-scope approval before this adapter is invoked.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx

from . import config


TOKEN_URL = "https://oauth2.googleapis.com/token"
CALENDAR_API = "https://www.googleapis.com/calendar/v3"
MAX_WINDOW_DAYS = 31
MAX_RESULTS = 50


def configured() -> bool:
    settings = config.settings
    return bool(
        settings.google_client_id
        and settings.google_client_secret
        and settings.google_refresh_token
        and settings.google_calendar_id
    )


def write_enabled() -> bool:
    return configured() and bool(config.settings.google_calendar_write_enabled)


def _parse_aware(value: str, name: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be an RFC3339 datetime")
    raw = value.strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an RFC3339 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must include a timezone offset")
    return parsed


def validate_window(start: str, end: str) -> tuple[datetime, datetime]:
    start_dt = _parse_aware(start, "start")
    end_dt = _parse_aware(end, "end")
    if end_dt <= start_dt:
        raise ValueError("Calendar end must be after start")
    if end_dt - start_dt > timedelta(days=MAX_WINDOW_DAYS):
        raise ValueError(f"Calendar read window cannot exceed {MAX_WINDOW_DAYS} days")
    return start_dt, end_dt


def validate_event_window(start: str, end: str) -> tuple[datetime, datetime]:
    start_dt = _parse_aware(start, "start")
    end_dt = _parse_aware(end, "end")
    if end_dt <= start_dt:
        raise ValueError("Calendar event end must be after start")
    if end_dt - start_dt > timedelta(days=7):
        raise ValueError("Calendar event duration cannot exceed 7 days")
    return start_dt, end_dt


def _rfc3339(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


async def _access_token() -> str:
    settings = config.settings
    if not configured():
        raise RuntimeError("Google Calendar is not configured")
    async with httpx.AsyncClient(timeout=settings.google_timeout_seconds) as client:
        response = await client.post(
            TOKEN_URL,
            data={
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "refresh_token": settings.google_refresh_token,
                "grant_type": "refresh_token",
            },
        )
        response.raise_for_status()
        payload = response.json()
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise RuntimeError("Google OAuth refresh returned no access token")
    return token


def _event_time(part: object) -> tuple[str | None, bool]:
    if not isinstance(part, dict):
        return None, False
    date_time = part.get("dateTime")
    if isinstance(date_time, str) and date_time:
        return date_time[:80], False
    date_value = part.get("date")
    if isinstance(date_value, str) and date_value:
        return date_value[:32], True
    return None, False


def _sanitise_event(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    event_id = raw.get("id")
    if not isinstance(event_id, str) or not event_id:
        return None
    start, start_all_day = _event_time(raw.get("start"))
    end, end_all_day = _event_time(raw.get("end"))
    if start is None or end is None:
        return None
    summary = raw.get("summary")
    status = raw.get("status")
    return {
        "id": event_id[:512],
        "summary": summary[:500] if isinstance(summary, str) else "(untitled event)",
        "start": start,
        "end": end,
        "all_day": bool(start_all_day or end_all_day),
        "status": status[:40] if isinstance(status, str) else "confirmed",
    }


def _event_payload(summary: str, start: str, end: str) -> dict:
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("Calendar event summary is required")
    if len(summary.strip()) > 500:
        raise ValueError("Calendar event summary cannot exceed 500 characters")
    start_dt, end_dt = validate_event_window(start, end)
    return {
        "summary": summary.strip(),
        "start": {"dateTime": start_dt.isoformat()},
        "end": {"dateTime": end_dt.isoformat()},
    }


def _event_id(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ValueError("Invalid Calendar event id")
    return value.strip()


async def list_events(start: str, end: str, limit: int = 20) -> dict:
    start_dt, end_dt = validate_window(start, end)
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > MAX_RESULTS:
        raise ValueError(f"Calendar limit must be between 1 and {MAX_RESULTS}")
    token = await _access_token()
    settings = config.settings
    calendar_id = quote(settings.google_calendar_id, safe="")
    async with httpx.AsyncClient(timeout=settings.google_timeout_seconds) as client:
        response = await client.get(
            f"{CALENDAR_API}/calendars/{calendar_id}/events",
            headers={"Authorization": f"Bearer {token}"},
            params={
                "timeMin": _rfc3339(start_dt),
                "timeMax": _rfc3339(end_dt),
                "singleEvents": "true",
                "orderBy": "startTime",
                "showDeleted": "false",
                "maxResults": str(limit),
            },
        )
        response.raise_for_status()
        payload = response.json()
    items = payload.get("items", []) if isinstance(payload, dict) else []
    events = []
    if isinstance(items, list):
        for item in items:
            event = _sanitise_event(item)
            if event is not None:
                events.append(event)
            if len(events) >= limit:
                break
    return {
        "ok": True,
        "calendar_id": "primary" if settings.google_calendar_id == "primary" else "configured",
        "events": events,
        "window": {"start": _rfc3339(start_dt), "end": _rfc3339(end_dt)},
    }


async def create_event(summary: str, start: str, end: str) -> dict:
    if not write_enabled():
        raise RuntimeError("Google Calendar writes are disabled")
    payload = _event_payload(summary, start, end)
    token = await _access_token()
    settings = config.settings
    calendar_id = quote(settings.google_calendar_id, safe="")
    async with httpx.AsyncClient(timeout=settings.google_timeout_seconds) as client:
        response = await client.post(
            f"{CALENDAR_API}/calendars/{calendar_id}/events",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        raw = response.json()
    event = _sanitise_event(raw)
    if event is None:
        raise RuntimeError("Google Calendar returned an invalid event")
    return {"ok": True, "event": event}


async def update_event(event_id: str, summary: str, start: str, end: str) -> dict:
    if not write_enabled():
        raise RuntimeError("Google Calendar writes are disabled")
    payload = _event_payload(summary, start, end)
    token = await _access_token()
    settings = config.settings
    calendar_id = quote(settings.google_calendar_id, safe="")
    safe_event_id = quote(_event_id(event_id), safe="")
    async with httpx.AsyncClient(timeout=settings.google_timeout_seconds) as client:
        response = await client.patch(
            f"{CALENDAR_API}/calendars/{calendar_id}/events/{safe_event_id}",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        raw = response.json()
    event = _sanitise_event(raw)
    if event is None or event["id"] != event_id:
        raise RuntimeError("Google Calendar returned an invalid updated event")
    return {"ok": True, "event": event}


async def delete_event(event_id: str) -> dict:
    if not write_enabled():
        raise RuntimeError("Google Calendar writes are disabled")
    token = await _access_token()
    settings = config.settings
    calendar_id = quote(settings.google_calendar_id, safe="")
    clean_event_id = _event_id(event_id)
    safe_event_id = quote(clean_event_id, safe="")
    async with httpx.AsyncClient(timeout=settings.google_timeout_seconds) as client:
        response = await client.delete(
            f"{CALENDAR_API}/calendars/{calendar_id}/events/{safe_event_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
    return {"ok": True, "event_id": clean_event_id, "deleted": True}


async def health() -> dict:
    """Validate credentials with no event content in the returned health data."""
    if not configured():
        return {"state": "not_configured"}
    try:
        token = await _access_token()
        settings = config.settings
        calendar_id = quote(settings.google_calendar_id, safe="")
        async with httpx.AsyncClient(timeout=settings.google_timeout_seconds) as client:
            response = await client.get(
                f"{CALENDAR_API}/calendars/{calendar_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            response.raise_for_status()
        return {"state": "ready", "write_enabled": bool(settings.google_calendar_write_enabled)}
    except Exception as exc:
        return {"state": "unavailable", "error_type": type(exc).__name__, "write_enabled": False}

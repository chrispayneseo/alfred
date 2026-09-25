"""Read-only Gmail REST adapter for Alfred Core.

Gmail credentials are separately scoped from Calendar and remain in the Dell
environment. Search results are metadata-minimised; full message reads expose a
bounded plain-text body only. This module intentionally contains no draft, send,
label mutation, archive or delete methods.
"""

from __future__ import annotations

import base64
import re

import httpx

from . import config


TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1"
MAX_SEARCH_RESULTS = 20
MAX_QUERY_CHARS = 500
MAX_BODY_CHARS = 12000
MAX_HEADER_CHARS = 500
MESSAGE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")


def configured() -> bool:
    settings = config.settings
    return bool(
        settings.gmail_client_id
        and settings.gmail_client_secret
        and settings.gmail_refresh_token
        and settings.gmail_user_id
    )


async def _access_token() -> str:
    settings = config.settings
    if not configured():
        raise RuntimeError("Gmail is not configured")
    async with httpx.AsyncClient(timeout=settings.gmail_timeout_seconds) as client:
        response = await client.post(
            TOKEN_URL,
            data={
                "client_id": settings.gmail_client_id,
                "client_secret": settings.gmail_client_secret,
                "refresh_token": settings.gmail_refresh_token,
                "grant_type": "refresh_token",
            },
        )
        response.raise_for_status()
        payload = response.json()
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise RuntimeError("Google OAuth refresh returned no Gmail access token")
    return token


def _clean_query(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Gmail search query is required")
    clean = value.strip()
    if len(clean) > MAX_QUERY_CHARS:
        raise ValueError(f"Gmail search query cannot exceed {MAX_QUERY_CHARS} characters")
    return clean


def _message_id(value: str) -> str:
    if not isinstance(value, str) or not MESSAGE_ID_RE.fullmatch(value.strip()):
        raise ValueError("Invalid Gmail message id")
    return value.strip()


def _headers(payload: object) -> dict[str, str]:
    if not isinstance(payload, dict):
        return {}
    values: dict[str, str] = {}
    raw_headers = payload.get("headers")
    if not isinstance(raw_headers, list):
        return values
    wanted = {"from", "to", "subject", "date"}
    for item in raw_headers:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        value = item.get("value")
        if not isinstance(name, str) or not isinstance(value, str):
            continue
        key = name.casefold()
        if key in wanted and key not in values:
            values[key] = value[:MAX_HEADER_CHARS]
    return values


def _summary(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    message_id = raw.get("id")
    thread_id = raw.get("threadId")
    if not isinstance(message_id, str) or not isinstance(thread_id, str):
        return None
    headers = _headers(raw.get("payload"))
    labels = raw.get("labelIds")
    label_ids = labels if isinstance(labels, list) else []
    snippet = raw.get("snippet")
    return {
        "id": message_id[:256],
        "thread_id": thread_id[:256],
        "from": headers.get("from", ""),
        "to": headers.get("to", ""),
        "subject": headers.get("subject", "(no subject)"),
        "date": headers.get("date", ""),
        "snippet": snippet[:1000] if isinstance(snippet, str) else "",
        "unread": "UNREAD" in label_ids,
    }


def _decode_body(data: object) -> str:
    if not isinstance(data, str) or not data:
        return ""
    try:
        padding = "=" * (-len(data) % 4)
        decoded = base64.urlsafe_b64decode((data + padding).encode("ascii"))
        return decoded.decode("utf-8", errors="replace")[:MAX_BODY_CHARS]
    except (ValueError, UnicodeEncodeError):
        return ""


def _plain_body(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    mime_type = payload.get("mimeType")
    body = payload.get("body")
    if mime_type == "text/plain" and isinstance(body, dict):
        value = _decode_body(body.get("data"))
        if value:
            return value
    parts = payload.get("parts")
    if isinstance(parts, list):
        for part in parts:
            value = _plain_body(part)
            if value:
                return value[:MAX_BODY_CHARS]
    return ""


async def _get_raw_message(client: httpx.AsyncClient, token: str, message_id: str, *, full: bool) -> dict:
    settings = config.settings
    response = await client.get(
        f"{GMAIL_API}/users/{settings.gmail_user_id}/messages/{_message_id(message_id)}",
        headers={"Authorization": f"Bearer {token}"},
        params={
            "format": "full" if full else "metadata",
            "metadataHeaders": ["From", "To", "Subject", "Date"],
        },
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Gmail returned an invalid message")
    return payload


async def search_messages(query: str, limit: int = 10) -> dict:
    clean_query = _clean_query(query)
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > MAX_SEARCH_RESULTS:
        raise ValueError(f"Gmail result limit must be between 1 and {MAX_SEARCH_RESULTS}")
    token = await _access_token()
    settings = config.settings
    async with httpx.AsyncClient(timeout=settings.gmail_timeout_seconds) as client:
        response = await client.get(
            f"{GMAIL_API}/users/{settings.gmail_user_id}/messages",
            headers={"Authorization": f"Bearer {token}"},
            params={"q": clean_query, "maxResults": str(limit)},
        )
        response.raise_for_status()
        payload = response.json()
        refs = payload.get("messages", []) if isinstance(payload, dict) else []
        messages: list[dict] = []
        if isinstance(refs, list):
            for ref in refs[:limit]:
                message_id = ref.get("id") if isinstance(ref, dict) else None
                if not isinstance(message_id, str):
                    continue
                raw = await _get_raw_message(client, token, message_id, full=False)
                item = _summary(raw)
                if item is not None:
                    messages.append(item)
    return {"ok": True, "messages": messages, "count": len(messages)}


async def get_message(message_id: str) -> dict:
    token = await _access_token()
    settings = config.settings
    async with httpx.AsyncClient(timeout=settings.gmail_timeout_seconds) as client:
        raw = await _get_raw_message(client, token, _message_id(message_id), full=True)
    item = _summary(raw)
    if item is None:
        raise RuntimeError("Gmail returned an invalid message")
    body = _plain_body(raw.get("payload"))
    item["body"] = body if body else item["snippet"]
    return {"ok": True, "message": item}


async def health() -> dict:
    """Validate read credentials without exposing mailbox identity or content."""
    if not configured():
        return {"state": "not_configured"}
    try:
        token = await _access_token()
        settings = config.settings
        async with httpx.AsyncClient(timeout=settings.gmail_timeout_seconds) as client:
            response = await client.get(
                f"{GMAIL_API}/users/{settings.gmail_user_id}/profile",
                headers={"Authorization": f"Bearer {token}"},
            )
            response.raise_for_status()
        return {"state": "ready", "mode": "read_only"}
    except Exception as exc:
        return {"state": "unavailable", "mode": "read_only", "error_type": type(exc).__name__}

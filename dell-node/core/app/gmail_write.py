"""Separately scoped Gmail mutation adapter for Alfred Core.

This module intentionally starts with draft creation only. It does not expose
send, reply, forward, archive, label, attachment or delete operations. Write
credentials are distinct from the read-only Gmail credentials and require an
explicit feature gate before Core can expose the capability.
"""

from __future__ import annotations

import base64
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
import re

import httpx

from . import config


TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1"
EMAIL_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")
MAX_SUBJECT_CHARS = 300
MAX_BODY_CHARS = 10000


def configured() -> bool:
    settings = config.settings
    return bool(
        settings.gmail_write_client_id
        and settings.gmail_write_client_secret
        and settings.gmail_write_refresh_token
        and settings.gmail_write_user_id
    )


def enabled() -> bool:
    return bool(config.settings.gmail_write_enabled and configured())


async def _access_token() -> str:
    settings = config.settings
    if not enabled():
        raise RuntimeError("Gmail draft writes are not enabled")
    async with httpx.AsyncClient(timeout=settings.gmail_timeout_seconds) as client:
        response = await client.post(
            TOKEN_URL,
            data={
                "client_id": settings.gmail_write_client_id,
                "client_secret": settings.gmail_write_client_secret,
                "refresh_token": settings.gmail_write_refresh_token,
                "grant_type": "refresh_token",
            },
        )
        response.raise_for_status()
        payload = response.json()
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise RuntimeError("Google OAuth refresh returned no Gmail write access token")
    return token


def _recipient(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Draft recipient must be an email address")
    clean = value.strip()
    if len(clean) > 320 or not EMAIL_RE.fullmatch(clean):
        raise ValueError("Draft recipient must be one valid email address")
    return clean


def _subject(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Draft subject must be text")
    clean = value.strip()
    if not clean or len(clean) > MAX_SUBJECT_CHARS or "\r" in clean or "\n" in clean:
        raise ValueError(f"Draft subject must be 1-{MAX_SUBJECT_CHARS} characters with no line breaks")
    return clean


def _body(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Draft body must be text")
    clean = value.strip()
    if not clean or len(clean) > MAX_BODY_CHARS:
        raise ValueError(f"Draft body must be 1-{MAX_BODY_CHARS} characters")
    return clean


def _raw_message(to: str, subject: str, body: str) -> str:
    message = EmailMessage()
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    return base64.urlsafe_b64encode(message.as_bytes(policy=policy.SMTP)).decode("ascii").rstrip("=")


def _decode_raw(value: object) -> bytes:
    if not isinstance(value, str) or not value:
        raise RuntimeError("Gmail returned no raw draft content")
    try:
        padding = "=" * (-len(value) % 4)
        return base64.urlsafe_b64decode((value + padding).encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise RuntimeError("Gmail returned invalid raw draft content") from exc


def _verified_draft(raw: object, *, expected_to: str, expected_subject: str,
                    expected_body: str, draft_id: str) -> dict:
    if not isinstance(raw, dict):
        raise RuntimeError("Gmail returned an invalid draft")
    message = raw.get("message")
    if not isinstance(message, dict):
        raise RuntimeError("Gmail returned an invalid draft message")
    message_id = message.get("id")
    if not isinstance(message_id, str) or not message_id:
        raise RuntimeError("Gmail returned no draft message id")
    parsed = BytesParser(policy=policy.default).parsebytes(_decode_raw(message.get("raw")))
    actual_to = str(parsed.get("To", "")).strip()
    actual_subject = str(parsed.get("Subject", "")).strip()
    if parsed.is_multipart():
        text_parts = [
            part.get_content()
            for part in parsed.walk()
            if part.get_content_type() == "text/plain" and not part.is_multipart()
        ]
        actual_body = "\n".join(str(part) for part in text_parts).strip()
    else:
        actual_body = str(parsed.get_content()).strip()
    verified = (
        actual_to.casefold() == expected_to.casefold()
        and actual_subject == expected_subject
        and actual_body == expected_body
    )
    if not verified:
        raise RuntimeError("Gmail draft read-back did not match the approved content")
    return {
        "id": draft_id[:256],
        "message_id": message_id[:256],
        "to": expected_to,
        "subject": expected_subject,
        "body_chars": len(expected_body),
        "verified": True,
    }


async def create_draft(to: str, subject: str, body: str) -> dict:
    clean_to = _recipient(to)
    clean_subject = _subject(subject)
    clean_body = _body(body)
    token = await _access_token()
    settings = config.settings
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=settings.gmail_timeout_seconds) as client:
        response = await client.post(
            f"{GMAIL_API}/users/{settings.gmail_write_user_id}/drafts",
            headers=headers,
            json={"message": {"raw": _raw_message(clean_to, clean_subject, clean_body)}},
        )
        response.raise_for_status()
        created = response.json()
        draft_id = created.get("id") if isinstance(created, dict) else None
        if not isinstance(draft_id, str) or not draft_id:
            raise RuntimeError("Gmail returned no draft id")
        verify_response = await client.get(
            f"{GMAIL_API}/users/{settings.gmail_write_user_id}/drafts/{draft_id}",
            headers=headers,
            params={"format": "raw"},
        )
        verify_response.raise_for_status()
        verified = _verified_draft(
            verify_response.json(),
            expected_to=clean_to,
            expected_subject=clean_subject,
            expected_body=clean_body,
            draft_id=draft_id,
        )
    return {"ok": True, "draft": verified}


async def health() -> dict:
    if not configured():
        return {"state": "not_configured", "mode": "draft_only", "enabled": False}
    if not config.settings.gmail_write_enabled:
        return {"state": "disabled", "mode": "draft_only", "enabled": False}
    try:
        await _access_token()
        return {"state": "ready", "mode": "draft_only", "enabled": True}
    except Exception as exc:
        return {
            "state": "unavailable",
            "mode": "draft_only",
            "enabled": True,
            "error_type": type(exc).__name__,
        }

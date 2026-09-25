"""Separately scoped Gmail mutation adapter for Alfred Core.

Draft creation and sending are intentionally narrow. Sending is allowed only for
an unchanged draft that Alfred previously created through a completed, verified
Core execution. There are no arbitrary compose-and-send, reply, forward, archive,
label, attachment or delete operations.
"""

from __future__ import annotations

import base64
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
import json
import re

import httpx

from . import config
from .db import connection


TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1"
EMAIL_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")
DRAFT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
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


def send_enabled() -> bool:
    return bool(config.settings.gmail_send_enabled and enabled())


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


def _draft_id(value: str) -> str:
    if not isinstance(value, str) or not DRAFT_ID_RE.fullmatch(value.strip()):
        raise ValueError("Invalid Gmail draft id")
    return value.strip()


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
        "id": _draft_id(draft_id),
        "message_id": message_id[:256],
        "to": expected_to,
        "subject": expected_subject,
        "body_chars": len(expected_body),
        "verified": True,
    }


def _execution_table_exists() -> bool:
    with connection() as db:
        return db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_executions'"
        ).fetchone() is not None


def _approved_draft_arguments(draft_id: str) -> dict | None:
    """Return the exact approved content for a verified Alfred-created draft."""
    clean_id = _draft_id(draft_id)
    if not _execution_table_exists():
        return None
    with connection() as db:
        rows = db.execute(
            """SELECT arguments, result, verification
               FROM core_executions
               WHERE action = 'email.draft.create' AND state = 'completed'
               ORDER BY completed_at DESC LIMIT 200"""
        ).fetchall()
    for row in rows:
        try:
            result = json.loads(row["result"] or "{}")
            verification = json.loads(row["verification"] or "{}")
            arguments = json.loads(row["arguments"] or "{}")
        except (TypeError, json.JSONDecodeError):
            continue
        draft = result.get("draft") if isinstance(result, dict) else None
        if not isinstance(draft, dict) or draft.get("id") != clean_id:
            continue
        if verification.get("ok") is not True or draft.get("verified") is not True:
            continue
        try:
            return {
                "to": _recipient(arguments.get("to")),
                "subject": _subject(arguments.get("subject")),
                "body": _body(arguments.get("body")),
            }
        except ValueError:
            return None
    return None


def _already_sent_by_alfred(draft_id: str) -> bool:
    clean_id = _draft_id(draft_id)
    if not _execution_table_exists():
        return False
    with connection() as db:
        rows = db.execute(
            """SELECT arguments FROM core_executions
               WHERE action = 'email.draft.send' AND state = 'completed'
               ORDER BY completed_at DESC LIMIT 200"""
        ).fetchall()
    for row in rows:
        try:
            arguments = json.loads(row["arguments"] or "{}")
        except (TypeError, json.JSONDecodeError):
            continue
        if arguments.get("draft_id") == clean_id:
            return True
    return False


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


async def send_draft(draft_id: str) -> dict:
    clean_id = _draft_id(draft_id)
    if not send_enabled():
        raise RuntimeError("Gmail sending is not enabled")
    if _already_sent_by_alfred(clean_id):
        raise PermissionError("This Gmail draft has already been sent by Alfred")
    approved = _approved_draft_arguments(clean_id)
    if approved is None:
        raise PermissionError("Only an unchanged, verified Alfred-created draft can be sent")

    token = await _access_token()
    settings = config.settings
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=settings.gmail_timeout_seconds) as client:
        draft_response = await client.get(
            f"{GMAIL_API}/users/{settings.gmail_write_user_id}/drafts/{clean_id}",
            headers=headers,
            params={"format": "raw"},
        )
        draft_response.raise_for_status()
        verified = _verified_draft(
            draft_response.json(),
            expected_to=approved["to"],
            expected_subject=approved["subject"],
            expected_body=approved["body"],
            draft_id=clean_id,
        )
        send_response = await client.post(
            f"{GMAIL_API}/users/{settings.gmail_write_user_id}/drafts/send",
            headers=headers,
            json={"id": clean_id},
        )
        send_response.raise_for_status()
        sent = send_response.json()
    sent_message_id = sent.get("id") if isinstance(sent, dict) else None
    if not isinstance(sent_message_id, str) or not sent_message_id:
        raise RuntimeError("Gmail returned no sent message id")
    return {
        "ok": True,
        "sent": {
            "draft_id": clean_id,
            "message_id": sent_message_id[:256],
            "to": verified["to"],
            "subject": verified["subject"],
            "verified_before_send": True,
        },
    }


async def health() -> dict:
    if not configured():
        return {
            "state": "not_configured",
            "mode": "draft_and_reviewed_send",
            "draft_enabled": False,
            "send_enabled": False,
        }
    if not config.settings.gmail_write_enabled:
        return {
            "state": "disabled",
            "mode": "draft_and_reviewed_send",
            "draft_enabled": False,
            "send_enabled": False,
        }
    try:
        await _access_token()
        return {
            "state": "ready",
            "mode": "draft_and_reviewed_send",
            "draft_enabled": True,
            "send_enabled": bool(config.settings.gmail_send_enabled),
        }
    except Exception as exc:
        return {
            "state": "unavailable",
            "mode": "draft_and_reviewed_send",
            "draft_enabled": True,
            "send_enabled": bool(config.settings.gmail_send_enabled),
            "error_type": type(exc).__name__,
        }

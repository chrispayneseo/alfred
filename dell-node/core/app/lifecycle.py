"""Durable request lifecycle state for Alfred Core.

Raw request text is intentionally not stored here. The lifecycle ledger keeps
only metadata plus a short SHA-256 fingerprint so status can be inspected without
creating another copy of personal conversation content.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter

from .db import connection


TERMINAL_STATES = {"completed", "failed", "denied", "connection_needed", "cloud_ready"}
VALID_STATES = {
    "received",
    "routing",
    "local_processing",
    "tool_planning",
    "awaiting_approval",
    "executing",
    "connection_needed",
    "cloud_ready",
    "completed",
    "failed",
    "denied",
}


def initialise_request_store() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS core_requests (
          request_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          state TEXT NOT NULL,
          route TEXT,
          provider TEXT,
          message_sha256 TEXT NOT NULL,
          message_length INTEGER NOT NULL,
          error_type TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS core_requests_state ON core_requests(state, updated_at DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS core_requests_conversation ON core_requests(conversation_id, updated_at DESC)")


def begin_request(request: dict) -> dict:
    initialise_request_store()
    message = request.get("message", "")
    fingerprint = hashlib.sha256(message.encode("utf-8")).hexdigest()
    with connection() as db:
        db.execute(
            """INSERT OR IGNORE INTO core_requests
               (request_id, conversation_id, channel, state, message_sha256, message_length)
               VALUES (?, ?, ?, 'received', ?, ?)""",
            (
                request["request_id"],
                request["conversation_id"],
                request["channel"],
                fingerprint,
                len(message),
            ),
        )
    return get_request(request["request_id"])


def transition_request(
    request_id: str,
    state: str,
    *,
    route: str | None = None,
    provider: str | None = None,
    error_type: str | None = None,
) -> dict | None:
    if state not in VALID_STATES:
        raise ValueError(f"Invalid Core request state: {state}")
    initialise_request_store()
    with connection() as db:
        result = db.execute(
            """UPDATE core_requests
               SET state = ?, route = COALESCE(?, route), provider = COALESCE(?, provider),
                   error_type = ?, updated_at = CURRENT_TIMESTAMP
               WHERE request_id = ?""",
            (state, route, provider, error_type, request_id),
        )
    return get_request(request_id) if result.rowcount else None


def get_request(request_id: str) -> dict | None:
    initialise_request_store()
    with connection() as db:
        row = db.execute(
            """SELECT request_id, conversation_id, channel, state, route, provider,
                      message_sha256, message_length, error_type, created_at, updated_at
               FROM core_requests WHERE request_id = ?""",
            (request_id,),
        ).fetchone()
    return dict(row) if row else None


def list_requests(limit: int = 50, state: str | None = None) -> list[dict]:
    initialise_request_store()
    size = max(1, min(limit, 100))
    with connection() as db:
        if state:
            rows = db.execute(
                """SELECT request_id, conversation_id, channel, state, route, provider,
                          message_sha256, message_length, error_type, created_at, updated_at
                   FROM core_requests WHERE state = ? ORDER BY updated_at DESC LIMIT ?""",
                (state, size),
            ).fetchall()
        else:
            rows = db.execute(
                """SELECT request_id, conversation_id, channel, state, route, provider,
                          message_sha256, message_length, error_type, created_at, updated_at
                   FROM core_requests ORDER BY updated_at DESC LIMIT ?""",
                (size,),
            ).fetchall()
    return [dict(row) for row in rows]


def request_timeline(request_id: str, limit: int = 100) -> list[dict]:
    size = max(1, min(limit, 200))
    with connection() as db:
        rows = db.execute(
            """SELECT id, occurred_at, event_type, request_id, conversation_id, data
               FROM audit_events WHERE request_id = ? ORDER BY occurred_at ASC LIMIT ?""",
            (request_id, size),
        ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        try:
            item["data"] = json.loads(item["data"])
        except (TypeError, json.JSONDecodeError):
            item["data"] = {}
        items.append(item)
    return items


def lifecycle_summary() -> dict:
    initialise_request_store()
    with connection() as db:
        rows = db.execute("SELECT state, COUNT(*) AS count FROM core_requests GROUP BY state").fetchall()
        pending_approvals = db.execute("SELECT COUNT(*) FROM approvals WHERE state = 'pending'").fetchone()[0]
        active_plans = db.execute(
            "SELECT COUNT(*) FROM plans WHERE state IN ('draft', 'running', 'awaiting_approval')"
        ).fetchone()[0]
        failed_executions = db.execute(
            "SELECT COUNT(*) FROM core_executions WHERE state = 'failed'"
        ).fetchone()[0] if db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_executions'"
        ).fetchone() else 0
    states = {row["state"]: row["count"] for row in rows}
    return {
        "requests": states,
        "pending_approvals": pending_approvals,
        "active_plans": active_plans,
        "failed_executions": failed_executions,
    }

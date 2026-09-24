"""TTL-limited local conversation context for Alfred Core.

Conversation turns are working context, not durable memory. They stay on the
Dell, expire automatically, are capped per conversation, and are never promoted
to long-term memory without an explicit memory write.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .db import connection


TTL_HOURS = 24
MAX_TURNS_PER_CONVERSATION = 20
MAX_CONTENT_CHARS = 4000


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS conversation_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          request_id TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS conversation_turns_conversation ON conversation_turns(conversation_id, id DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS conversation_turns_expires ON conversation_turns(expires_at)")
        db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_request_role
          ON conversation_turns(request_id, role)
          WHERE request_id IS NOT NULL""")


def prune_expired(*, now: datetime | None = None) -> int:
    initialise()
    current = now or _now()
    with connection() as db:
        result = db.execute(
            "DELETE FROM conversation_turns WHERE expires_at <= ?",
            (_iso(current),),
        )
    return int(result.rowcount)


def _prune_overflow(conversation_id: str) -> None:
    with connection() as db:
        db.execute(
            """DELETE FROM conversation_turns
               WHERE conversation_id = ? AND id NOT IN (
                 SELECT id FROM conversation_turns
                 WHERE conversation_id = ?
                 ORDER BY id DESC LIMIT ?
               )""",
            (conversation_id, conversation_id, MAX_TURNS_PER_CONVERSATION),
        )


def record_turn(
    conversation_id: str,
    role: str,
    content: str,
    *,
    request_id: str | None = None,
    ttl_hours: int = TTL_HOURS,
    now: datetime | None = None,
) -> bool:
    """Store one local working-context turn; retries are idempotent by request+role."""
    clean_conversation = conversation_id.strip()[:160]
    clean_role = role.strip().casefold()
    clean_content = content.strip()[:MAX_CONTENT_CHARS]
    if not clean_conversation:
        raise ValueError("conversation_id is required")
    if clean_role not in {"user", "assistant"}:
        raise ValueError("role must be user or assistant")
    if not clean_content:
        return False
    if ttl_hours < 1 or ttl_hours > 168:
        raise ValueError("ttl_hours must be between 1 and 168")

    initialise()
    current = now or _now()
    expires = current + timedelta(hours=ttl_hours)
    clean_request_id = request_id.strip()[:64] if isinstance(request_id, str) and request_id.strip() else None
    with connection() as db:
        result = db.execute(
            """INSERT OR IGNORE INTO conversation_turns
               (conversation_id, role, content, request_id, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                clean_conversation,
                clean_role,
                clean_content,
                clean_request_id,
                _iso(current),
                _iso(expires),
            ),
        )
    _prune_overflow(clean_conversation)
    prune_expired(now=current)
    return bool(result.rowcount)


def recent_turns(
    conversation_id: str,
    *,
    limit: int = 12,
    max_chars: int = 5000,
    now: datetime | None = None,
) -> list[dict[str, str]]:
    """Return chronological recent turns inside a hard local-context budget."""
    clean_conversation = conversation_id.strip()[:160]
    if not clean_conversation:
        return []
    initialise()
    current = now or _now()
    prune_expired(now=current)
    size = max(1, min(limit, MAX_TURNS_PER_CONVERSATION))
    budget = max(256, min(max_chars, 12000))
    with connection() as db:
        rows = db.execute(
            """SELECT role, content FROM conversation_turns
               WHERE conversation_id = ? AND expires_at > ?
               ORDER BY id DESC LIMIT ?""",
            (clean_conversation, _iso(current), size),
        ).fetchall()

    selected: list[dict[str, str]] = []
    used = 0
    for row in rows:  # newest -> oldest; take as much recent context as fits
        content = str(row["content"] or "")[:MAX_CONTENT_CHARS]
        cost = len(content) + 24
        if used + cost > budget:
            remaining = budget - used - 24
            if remaining < 80:
                break
            content = content[: max(0, remaining - 1)].rstrip() + "…"
            cost = len(content) + 24
        selected.append({"role": row["role"], "content": content})
        used += cost
        if used >= budget:
            break
    selected.reverse()
    return selected


def sanitise_external_history(history: list[dict] | None, *, limit: int = 10) -> list[dict[str, str]]:
    """Accept only user/assistant text from caller-provided history; never system roles."""
    if not history:
        return []
    cleaned: list[dict[str, str]] = []
    for item in history[-max(1, min(limit, 20)):]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue
        text = content.strip()[:2000]
        if text:
            cleaned.append({"role": role, "content": text})
    return cleaned


def merge_history(stored: list[dict[str, str]], supplied: list[dict] | None) -> list[dict[str, str]]:
    """Merge local + caller context without duplicating identical adjacent turns."""
    merged: list[dict[str, str]] = []
    for item in [*stored, *sanitise_external_history(supplied)]:
        if merged and merged[-1] == item:
            continue
        merged.append(item)
    return merged[-12:]


def clear_conversation(conversation_id: str) -> int:
    initialise()
    with connection() as db:
        result = db.execute(
            "DELETE FROM conversation_turns WHERE conversation_id = ?",
            (conversation_id.strip()[:160],),
        )
    return int(result.rowcount)


def record_assistant_for_request(request_id: str, reply: str) -> bool:
    """Attach a completed response to the request's local conversation, if known."""
    initialise()
    with connection() as db:
        row = db.execute(
            "SELECT conversation_id FROM core_requests WHERE request_id = ?",
            (request_id,),
        ).fetchone()
    if row is None:
        return False
    return record_turn(row["conversation_id"], "assistant", reply, request_id=request_id)

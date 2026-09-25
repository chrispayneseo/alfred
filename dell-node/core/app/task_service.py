"""Core-local task/reminder service backed by Alfred's existing inbox_filed table.

This module is the tool-facing boundary for tasks and reminders. It deliberately
reuses the current durable table and FTS index so WhatsApp-filed items, manual
items and Core-created items remain one coherent list.
"""

from __future__ import annotations

import sqlite3
from datetime import date
from uuid import uuid4

from .db import connection


KINDS = {"task", "reminder"}


def initialise() -> None:
    """Idempotently ensure the existing task/reminder store and FTS index exist."""
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS inbox_filed (
            source_id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
            due TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        existing = {row[1] for row in db.execute("PRAGMA table_info(inbox_filed)")}
        for name in ("completed_at", "notified_at", "notify_attempt_at", "memory_id"):
            if name not in existing:
                db.execute(f"ALTER TABLE inbox_filed ADD COLUMN {name} {'INTEGER' if name == 'memory_id' else 'TEXT'}")
        db.execute("CREATE INDEX IF NOT EXISTS inbox_filed_due ON inbox_filed(kind, due, completed_at, notified_at)")
        new_index = db.execute("SELECT 1 FROM sqlite_master WHERE name = 'inbox_filed_fts'").fetchone() is None
        db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS inbox_filed_fts USING fts5(title, detail, content='inbox_filed', content_rowid='rowid')")
        db.execute("""CREATE TRIGGER IF NOT EXISTS inbox_filed_fts_ai AFTER INSERT ON inbox_filed BEGIN
          INSERT INTO inbox_filed_fts(rowid, title, detail) VALUES (new.rowid, new.title, new.detail);
        END""")
        db.execute("""CREATE TRIGGER IF NOT EXISTS inbox_filed_fts_ad AFTER DELETE ON inbox_filed BEGIN
          INSERT INTO inbox_filed_fts(inbox_filed_fts, rowid, title, detail)
            VALUES ('delete', old.rowid, old.title, old.detail);
        END""")
        db.execute("""CREATE TRIGGER IF NOT EXISTS inbox_filed_fts_au AFTER UPDATE OF title, detail ON inbox_filed BEGIN
          INSERT INTO inbox_filed_fts(inbox_filed_fts, rowid, title, detail)
            VALUES ('delete', old.rowid, old.title, old.detail);
          INSERT INTO inbox_filed_fts(rowid, title, detail) VALUES (new.rowid, new.title, new.detail);
        END""")
        if new_index:
            db.execute("INSERT INTO inbox_filed_fts(inbox_filed_fts) VALUES ('rebuild')")


def _due(value: str | None, *, required: bool = False) -> str | None:
    if value in (None, ""):
        if required:
            raise ValueError("A reminder needs a due date")
        return None
    if not isinstance(value, str):
        raise ValueError("Due date must be YYYY-MM-DD")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValueError("Due date must be YYYY-MM-DD") from exc


def _clean_kind(kind: str) -> str:
    value = kind.strip().casefold() if isinstance(kind, str) else ""
    if value not in KINDS:
        raise ValueError("Task kind must be task or reminder")
    return value


def _clean_title(title: str) -> str:
    value = title.strip()[:200] if isinstance(title, str) else ""
    if not value:
        raise ValueError("Task title is required")
    return value


def _clean_detail(detail: str | None) -> str:
    if detail is None:
        return ""
    if not isinstance(detail, str):
        raise ValueError("Task detail must be text")
    return detail.strip()[:1000]


def _serialise(row) -> dict | None:
    if row is None:
        return None
    item = dict(row)
    return {
        "source_id": item["source_id"],
        "kind": item["kind"],
        "title": item["title"],
        "due": item.get("due"),
        "detail": item.get("detail") or "",
        "completed": item.get("completed_at") is not None,
        "created_at": item.get("created_at"),
    }


def get(source_id: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute(
            """SELECT source_id, kind, title, due, detail, completed_at, created_at
               FROM inbox_filed WHERE source_id = ? AND kind IN ('task', 'reminder')""",
            (source_id,),
        ).fetchone()
    return _serialise(row)


def list_items(*, kind: str | None = None, include_completed: bool = False,
               limit: int = 50) -> list[dict]:
    initialise()
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
        raise ValueError("Task list limit must be between 1 and 100")
    clean_kind = _clean_kind(kind) if kind is not None else None
    clauses = ["kind IN ('task', 'reminder')"]
    params: list[object] = []
    if clean_kind:
        clauses.append("kind = ?")
        params.append(clean_kind)
    if not include_completed:
        clauses.append("completed_at IS NULL")
    params.append(limit)
    with connection() as db:
        rows = db.execute(
            f"""SELECT source_id, kind, title, due, detail, completed_at, created_at
                FROM inbox_filed WHERE {' AND '.join(clauses)}
                ORDER BY CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, created_at DESC
                LIMIT ?""",
            params,
        ).fetchall()
    return [_serialise(row) or {} for row in rows]


def create(*, kind: str, title: str, due: str | None = None,
           detail: str = "") -> dict:
    initialise()
    clean_kind = _clean_kind(kind)
    clean_title = _clean_title(title)
    clean_due = _due(due, required=clean_kind == "reminder")
    clean_detail = _clean_detail(detail)
    source_id = f"core:{uuid4()}"
    with connection() as db:
        db.execute(
            """INSERT INTO inbox_filed (source_id, kind, title, due, detail)
               VALUES (?, ?, ?, ?, ?)""",
            (source_id, clean_kind, clean_title, clean_due, clean_detail),
        )
    item = get(source_id)
    if item is None:
        raise RuntimeError("Task could not be stored")
    return item


def update(source_id: str, *, title: str, due: str | None = None,
           detail: str = "") -> dict:
    initialise()
    existing = get(source_id)
    if existing is None:
        raise LookupError("Task or reminder not found")
    clean_title = _clean_title(title)
    clean_due = _due(due, required=existing["kind"] == "reminder")
    clean_detail = _clean_detail(detail)
    with connection() as db:
        result = db.execute(
            """UPDATE inbox_filed SET title = ?, due = ?, detail = ?,
               notified_at = CASE WHEN due IS NOT ? THEN NULL ELSE notified_at END,
               notify_attempt_at = CASE WHEN due IS NOT ? THEN NULL ELSE notify_attempt_at END
               WHERE source_id = ? AND kind IN ('task', 'reminder')""",
            (clean_title, clean_due, clean_detail, clean_due, clean_due, source_id),
        )
        if result.rowcount == 0:
            raise LookupError("Task or reminder not found")
    item = get(source_id)
    if item is None:
        raise RuntimeError("Updated task could not be read back")
    return item


def set_completed(source_id: str, completed: bool) -> dict:
    initialise()
    if not isinstance(completed, bool):
        raise ValueError("completed must be true or false")
    with connection() as db:
        result = db.execute(
            """UPDATE inbox_filed
               SET completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
               WHERE source_id = ? AND kind IN ('task', 'reminder')""",
            (completed, source_id),
        )
        if result.rowcount == 0:
            raise LookupError("Task or reminder not found")
    item = get(source_id)
    if item is None:
        raise RuntimeError("Task completion could not be read back")
    return item


def delete(source_id: str) -> bool:
    initialise()
    with connection() as db:
        result = db.execute(
            "DELETE FROM inbox_filed WHERE source_id = ? AND kind IN ('task', 'reminder')",
            (source_id,),
        )
    return bool(result.rowcount)

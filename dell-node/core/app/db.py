from __future__ import annotations

import sqlite3
import re
from contextlib import contextmanager
from typing import Optional
from .config import settings


@contextmanager
def connection():
    db = sqlite3.connect(settings.sqlite_path)
    db.row_factory = sqlite3.Row
    try:
        yield db
        db.commit()
    finally:
        db.close()


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          kind TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'api'
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS memories_created ON memories(created_at DESC)")
        db.execute("""CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, event_type TEXT NOT NULL,
          request_id TEXT, conversation_id TEXT, data TEXT NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS audit_events_request ON audit_events(request_id, occurred_at DESC)")
        db.execute("""CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY, request_id TEXT, goal TEXT NOT NULL, state TEXT NOT NULL,
          steps TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY, request_id TEXT, plan_id TEXT, action TEXT NOT NULL,
          summary TEXT NOT NULL, risk_level TEXT NOT NULL, state TEXT NOT NULL,
          scope_hash TEXT, step_index INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT
        )""")
        approval_columns = {row["name"] for row in db.execute("PRAGMA table_info(approvals)").fetchall()}
        if "scope_hash" not in approval_columns:
            db.execute("ALTER TABLE approvals ADD COLUMN scope_hash TEXT")
        if "step_index" not in approval_columns:
            db.execute("ALTER TABLE approvals ADD COLUMN step_index INTEGER")
        db.execute("CREATE INDEX IF NOT EXISTS approvals_scope ON approvals(request_id, plan_id, action, scope_hash, state)")
        db.execute("""CREATE TABLE IF NOT EXISTS core_events (
          id TEXT PRIMARY KEY, event_type TEXT NOT NULL, source TEXT NOT NULL,
          decision TEXT NOT NULL, payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        new_index = db.execute("SELECT 1 FROM sqlite_master WHERE name = 'memories_fts'").fetchone() is None
        db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='id')")
        db.execute("""CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END""")
        db.execute("""CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END""")
        db.execute("""CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END""")
        if new_index:
            db.execute("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')")


def record_audit(event_type: str, data: dict, request_id: Optional[str] = None,
                 conversation_id: Optional[str] = None) -> str:
    """Append a Core decision/event without storing unbounded raw conversations."""
    import json
    import uuid
    event_id = str(uuid.uuid4())
    with connection() as db:
        db.execute("""INSERT INTO audit_events (id, occurred_at, event_type, request_id, conversation_id, data)
          VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?)""",
          (event_id, event_type, request_id, conversation_id, json.dumps(data, separators=(",", ":"))))
    return event_id


def create_plan(request_id: str, goal: str, steps: list[dict]) -> dict:
    import json
    import uuid
    plan_id = str(uuid.uuid4())
    with connection() as db:
        db.execute("INSERT INTO plans (id, request_id, goal, state, steps) VALUES (?, ?, ?, 'draft', ?)",
                   (plan_id, request_id, goal, json.dumps(steps, separators=(",", ":"))))
    return {"id": plan_id, "request_id": request_id, "goal": goal, "state": "draft", "steps": steps}


def list_plans(limit: int = 50) -> list[dict]:
    import json
    with connection() as db:
        rows = db.execute("SELECT id, request_id, goal, state, steps, created_at, updated_at FROM plans ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [{**dict(row), "steps": json.loads(row["steps"])} for row in rows]


def create_approval(request_id: str, plan_id: Optional[str], action: str, summary: str,
                    risk_level: str, scope_hash: Optional[str] = None,
                    step_index: Optional[int] = None) -> dict:
    import uuid
    approval_id = str(uuid.uuid4())
    with connection() as db:
        db.execute("""INSERT INTO approvals
          (id, request_id, plan_id, action, summary, risk_level, state, scope_hash, step_index)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)""",
          (approval_id, request_id, plan_id, action, summary, risk_level, scope_hash, step_index))
    return {
        "id": approval_id,
        "state": "pending",
        "action": action,
        "summary": summary,
        "risk_level": risk_level,
        "scope_hash": scope_hash,
        "step_index": step_index,
    }


def resolve_approval(approval_id: str, approved: bool) -> bool:
    with connection() as db:
        result = db.execute(
            "UPDATE approvals SET state = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'pending'",
            ("approved" if approved else "rejected", approval_id),
        )
    return bool(result.rowcount)


def record_event(event_type: str, source: str, decision: str, payload: dict) -> dict:
    import json
    import uuid
    event_id = str(uuid.uuid4())
    with connection() as db:
        db.execute("INSERT INTO core_events (id, event_type, source, decision, payload) VALUES (?, ?, ?, ?, ?)",
                   (event_id, event_type, source, decision, json.dumps(payload, separators=(",", ":"))))
    return {"id": event_id, "event_type": event_type, "source": source, "decision": decision}


def remember(kind: str, content: str, source: str) -> int:
    with connection() as db:
        return db.execute("INSERT INTO memories(kind, content, source) VALUES (?, ?, ?)",
                          (kind, content, source)).lastrowid


def recall(query: str, limit: int = 8) -> list[dict]:
    terms = [term for term in re.findall(r"[\w'-]{3,}", query.lower())
             if term not in {"what", "when", "where", "about", "with", "that", "this", "please", "could", "would", "know"}]
    terms = list(dict.fromkeys(terms))[:8]
    if not terms:
        return []
    clauses = " OR ".join("(content LIKE ? OR kind LIKE ?)" for _ in terms)
    params = [value for term in terms for value in (f"%{term}%", f"%{term}%")]
    with connection() as db:
        rows = db.execute(f"""SELECT id, created_at, kind, content, source FROM memories
          WHERE {clauses} ORDER BY created_at DESC LIMIT ?""", (*params, limit)).fetchall()
    return [dict(row) for row in rows]


def list_memories(limit: int = 50) -> list[dict]:
    with connection() as db:
        rows = db.execute("""SELECT id, created_at, kind, content, source FROM memories
          ORDER BY id DESC LIMIT ?""", (limit,)).fetchall()
    return [dict(row) for row in rows]


def forget(memory_id: int) -> bool:
    with connection() as db:
        if db.execute("SELECT 1 FROM sqlite_master WHERE name = 'inbox_filed'").fetchone():
            db.execute("DELETE FROM inbox_filed WHERE memory_id = ? AND kind = 'note'", (memory_id,))
        result = db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        return result.rowcount > 0


def get_memory(memory_id: int) -> dict | None:
    with connection() as db:
        row = db.execute("SELECT id, created_at, kind, content, source FROM memories WHERE id = ?", (memory_id,)).fetchone()
        return dict(row) if row else None


def correct_memory(memory_id: int, content: str) -> bool:
    with connection() as db:
        result = db.execute("UPDATE memories SET content = ? WHERE id = ?", (content, memory_id))
        if result.rowcount and db.execute("SELECT 1 FROM sqlite_master WHERE name = 'inbox_filed'").fetchone():
            title, _, detail = content.partition("\n")
            db.execute("UPDATE inbox_filed SET title = ?, detail = ? WHERE memory_id = ? AND kind = 'note'",
                       (title[:200], detail[:1000], memory_id))
        return result.rowcount > 0

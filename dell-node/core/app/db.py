import sqlite3
import re
from contextlib import contextmanager
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
        result = db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        return result.rowcount > 0

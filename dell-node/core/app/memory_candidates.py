"""Deterministic memory-candidate review, duplicate detection and supersession.

Candidates are not durable memories and never participate in retrieval until an
explicit promotion succeeds through Alfred Core. Conflict detection is local and
conservative: likely contradictions are flagged for owner review, never resolved
by a model.
"""

from __future__ import annotations

import json
import re
from uuid import uuid4

from .db import connection
from .memory_context import fingerprint
from .memory_graph import similarity


OPEN_STATES = {"pending", "conflict"}
FINAL_STATES = {"duplicate", "promoted", "dismissed"}
NEGATIVE_TERMS = {
    "not", "never", "no", "dislike", "dislikes", "disliked", "hate", "hates",
    "hated", "cannot", "cant", "doesnt", "isnt", "wont",
    "stopped", "stops", "avoid", "avoids",
}
POSITIVE_TERMS = {
    "like", "likes", "liked", "love", "loves", "loved", "enjoy", "enjoys",
    "enjoyed", "prefer", "prefers", "preferred", "want", "wants", "wanted",
    "has", "have", "uses", "use", "is", "are",
}


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS memory_candidates (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          source TEXT NOT NULL,
          source_request_id TEXT,
          source_conversation_id TEXT,
          confidence REAL NOT NULL DEFAULT 0.8 CHECK(confidence >= 0 AND confidence <= 1),
          fingerprint TEXT NOT NULL,
          state TEXT NOT NULL,
          duplicate_memory_id INTEGER,
          conflict_memory_id INTEGER,
          promoted_memory_id INTEGER,
          analysis TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at TEXT
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS memory_candidates_state ON memory_candidates(state, created_at DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS memory_candidates_fingerprint ON memory_candidates(fingerprint, state)")
        db.execute("""CREATE TABLE IF NOT EXISTS memory_supersessions (
          memory_id INTEGER PRIMARY KEY,
          superseded_by_memory_id INTEGER NOT NULL,
          reason TEXT NOT NULL DEFAULT 'owner_replacement',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS memory_supersessions_by ON memory_supersessions(superseded_by_memory_id)")


def _polarity(value: str) -> int:
    normalised = value.casefold().replace("’", "'").replace("'", "")
    tokens = set(re.findall(r"[^\W_]+", normalised, re.UNICODE))
    if tokens & NEGATIVE_TERMS:
        return -1
    if tokens & POSITIVE_TERMS:
        return 1
    return 0


def _active_memories(limit: int = 1500) -> list[dict]:
    initialise()
    with connection() as db:
        rows = db.execute(
            """SELECT m.id, m.kind, m.content, m.source
               FROM memories m
               LEFT JOIN memory_supersessions s ON s.memory_id = m.id
               WHERE s.memory_id IS NULL
               ORDER BY m.id DESC LIMIT ?""",
            (max(1, min(limit, 5000)),),
        ).fetchall()
    return [dict(row) for row in rows]


def find_exact_duplicate(content: str) -> dict | None:
    target = fingerprint(content)
    for item in _active_memories():
        if fingerprint(item["content"]) == target:
            return item
    return None


def _analyse(content: str) -> dict:
    exact = find_exact_duplicate(content)
    if exact is not None:
        return {
            "state": "duplicate",
            "duplicate_memory_id": exact["id"],
            "conflict_memory_id": None,
            "analysis": {"reason": "exact_normalised_duplicate"},
        }

    candidate_polarity = _polarity(content)
    best_conflict: tuple[float, dict] | None = None
    related: list[dict] = []
    for item in _active_memories():
        score, shared = similarity(content, item["content"])
        if shared < 2 or score < 0.24:
            continue
        related.append({"memory_id": item["id"], "score": round(score, 4), "shared_terms": shared})
        existing_polarity = _polarity(item["content"])
        if candidate_polarity and existing_polarity and candidate_polarity != existing_polarity and score >= 0.34:
            if best_conflict is None or score > best_conflict[0]:
                best_conflict = (score, item)

    related.sort(key=lambda item: (-item["score"], item["memory_id"]))
    if best_conflict is not None:
        return {
            "state": "conflict",
            "duplicate_memory_id": None,
            "conflict_memory_id": best_conflict[1]["id"],
            "analysis": {
                "reason": "opposing_polarity_with_shared_context",
                "similarity": round(best_conflict[0], 4),
                "related": related[:5],
            },
        }
    return {
        "state": "pending",
        "duplicate_memory_id": None,
        "conflict_memory_id": None,
        "analysis": {"reason": "new_candidate", "related": related[:5]},
    }


def _row(row) -> dict | None:
    if row is None:
        return None
    item = dict(row)
    try:
        item["analysis"] = json.loads(item.get("analysis") or "{}")
    except json.JSONDecodeError:
        item["analysis"] = {}
    return item


def propose(
    content: str,
    *,
    memory_type: str = "fact",
    source: str = "local-context",
    source_request_id: str | None = None,
    source_conversation_id: str | None = None,
    confidence: float = 0.8,
) -> dict:
    initialise()
    clean_content = content.strip()[:4000]
    clean_type = memory_type.strip().casefold()[:64] or "fact"
    clean_source = source.strip()[:64] or "local-context"
    if not clean_content:
        raise ValueError("Candidate content is required")
    if not 0 <= confidence <= 1:
        raise ValueError("confidence must be between 0 and 1")
    content_fingerprint = fingerprint(clean_content)

    with connection() as db:
        existing = db.execute(
            """SELECT * FROM memory_candidates
               WHERE fingerprint = ? AND state IN ('pending', 'conflict', 'duplicate')
               ORDER BY created_at DESC LIMIT 1""",
            (content_fingerprint,),
        ).fetchone()
    if existing is not None:
        return _row(existing) or {}

    analysis = _analyse(clean_content)
    candidate_id = str(uuid4())
    with connection() as db:
        db.execute(
            """INSERT INTO memory_candidates
               (id, content, memory_type, source, source_request_id, source_conversation_id,
                confidence, fingerprint, state, duplicate_memory_id, conflict_memory_id, analysis)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                candidate_id,
                clean_content,
                clean_type,
                clean_source,
                source_request_id,
                source_conversation_id,
                float(confidence),
                content_fingerprint,
                analysis["state"],
                analysis["duplicate_memory_id"],
                analysis["conflict_memory_id"],
                json.dumps(analysis["analysis"], separators=(",", ":")),
            ),
        )
        row = db.execute("SELECT * FROM memory_candidates WHERE id = ?", (candidate_id,)).fetchone()
    return _row(row) or {}


def get(candidate_id: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute("SELECT * FROM memory_candidates WHERE id = ?", (candidate_id,)).fetchone()
    return _row(row)


def list_candidates(state: str | None = None, limit: int = 50) -> list[dict]:
    initialise()
    size = max(1, min(limit, 100))
    with connection() as db:
        if state:
            rows = db.execute(
                "SELECT * FROM memory_candidates WHERE state = ? ORDER BY created_at DESC LIMIT ?",
                (state, size),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM memory_candidates ORDER BY created_at DESC LIMIT ?",
                (size,),
            ).fetchall()
    return [_row(row) or {} for row in rows]


def dismiss(candidate_id: str) -> dict | None:
    initialise()
    with connection() as db:
        result = db.execute(
            """UPDATE memory_candidates SET state = 'dismissed', resolved_at = CURRENT_TIMESTAMP
               WHERE id = ? AND state IN ('pending', 'conflict', 'duplicate')""",
            (candidate_id,),
        )
        if not result.rowcount:
            row = db.execute("SELECT * FROM memory_candidates WHERE id = ?", (candidate_id,)).fetchone()
            return _row(row)
        row = db.execute("SELECT * FROM memory_candidates WHERE id = ?", (candidate_id,)).fetchone()
    return _row(row)


def validate_promotion(candidate_id: str, supersede_memory_id: int | None = None) -> dict:
    candidate = get(candidate_id)
    if candidate is None:
        raise LookupError("Memory candidate not found")
    if candidate["state"] == "duplicate":
        raise ValueError("Duplicate candidate cannot be promoted")
    if candidate["state"] == "promoted":
        return candidate
    if candidate["state"] == "dismissed":
        raise ValueError("Dismissed candidate cannot be promoted")
    conflict_id = candidate.get("conflict_memory_id")
    if candidate["state"] == "conflict" and supersede_memory_id != conflict_id:
        raise ValueError("Conflicting candidate requires explicit supersession of the flagged memory")
    if supersede_memory_id is not None:
        with connection() as db:
            row = db.execute(
                """SELECT m.id, m.content FROM memories m
                   LEFT JOIN memory_supersessions s ON s.memory_id = m.id
                   WHERE m.id = ? AND s.memory_id IS NULL""",
                (supersede_memory_id,),
            ).fetchone()
        if row is None:
            raise ValueError("Superseded memory must exist and still be active")
        score, shared = similarity(candidate["content"], row["content"])
        if shared < 2 or score < 0.24:
            raise ValueError("Candidate is not sufficiently related to the memory being superseded")
    return candidate


def mark_superseded(memory_id: int, superseded_by_memory_id: int, *, reason: str) -> None:
    initialise()
    if memory_id == superseded_by_memory_id:
        return
    with connection() as db:
        db.execute(
            """INSERT OR REPLACE INTO memory_supersessions
               (memory_id, superseded_by_memory_id, reason)
               VALUES (?, ?, ?)""",
            (memory_id, superseded_by_memory_id, reason[:64]),
        )


def mark_promoted(candidate_id: str, memory_id: int, supersede_memory_id: int | None = None) -> dict:
    initialise()
    if supersede_memory_id is not None:
        mark_superseded(supersede_memory_id, memory_id, reason="owner_replacement")
    with connection() as db:
        db.execute(
            """UPDATE memory_candidates
               SET state = 'promoted', promoted_memory_id = ?, resolved_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (memory_id, candidate_id),
        )
        row = db.execute("SELECT * FROM memory_candidates WHERE id = ?", (candidate_id,)).fetchone()
    return _row(row) or {}


def superseded_memory_ids() -> set[int]:
    initialise()
    with connection() as db:
        rows = db.execute("SELECT memory_id FROM memory_supersessions").fetchall()
    return {int(row["memory_id"]) for row in rows}


def is_superseded(memory_id: int) -> bool:
    initialise()
    with connection() as db:
        row = db.execute("SELECT 1 FROM memory_supersessions WHERE memory_id = ?", (memory_id,)).fetchone()
    return row is not None


def remove_memory_references(memory_id: int) -> None:
    """Keep supersession state coherent if either side of a replacement is deleted."""
    initialise()
    with connection() as db:
        db.execute(
            "DELETE FROM memory_supersessions WHERE memory_id = ? OR superseded_by_memory_id = ?",
            (memory_id, memory_id),
        )


def filter_active_context(items: list[dict]) -> list[dict]:
    superseded = superseded_memory_ids()
    if not superseded:
        return items
    active = []
    for item in items:
        value = str(item.get("id", ""))
        if value.startswith("memory:"):
            try:
                memory_id = int(value.split(":", 1)[1])
            except ValueError:
                memory_id = None
            if memory_id in superseded:
                continue
        active.append(item)
    return active

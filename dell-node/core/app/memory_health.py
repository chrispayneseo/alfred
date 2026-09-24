"""Read-only health summary for Alfred's Phase 2 memory/context system."""

from __future__ import annotations

from .db import connection
from . import memory_candidates


def _table_exists(db, name: str) -> bool:
    return db.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        (name,),
    ).fetchone() is not None


def memory_health() -> dict:
    """Return bounded metadata about memory quality without exposing memory text."""
    memory_candidates.initialise()
    candidate_review = memory_candidates.review_summary()

    with connection() as db:
        total_memories = int(db.execute("SELECT COUNT(*) FROM memories").fetchone()[0])
        metadata_rows = int(db.execute("SELECT COUNT(*) FROM memory_metadata").fetchone()[0]) \
            if _table_exists(db, "memory_metadata") else 0
        superseded = int(db.execute("SELECT COUNT(*) FROM memory_supersessions").fetchone()[0])
        active_memories = int(db.execute(
            """SELECT COUNT(*) FROM memories m
               LEFT JOIN memory_supersessions s ON s.memory_id = m.id
               WHERE s.memory_id IS NULL"""
        ).fetchone()[0])
        relations = int(db.execute("SELECT COUNT(*) FROM memory_relations").fetchone()[0]) \
            if _table_exists(db, "memory_relations") else 0
        short_term_turns = int(db.execute(
            "SELECT COUNT(*) FROM conversation_turns WHERE expires_at > CURRENT_TIMESTAMP"
        ).fetchone()[0]) if _table_exists(db, "conversation_turns") else 0
        task_reminders = int(db.execute(
            """SELECT COUNT(*) FROM inbox_filed
               WHERE kind IN ('task', 'reminder') AND completed_at IS NULL"""
        ).fetchone()[0]) if _table_exists(db, "inbox_filed") else 0

    metadata_coverage = 1.0 if total_memories == 0 else min(1.0, metadata_rows / total_memories)
    return {
        "status": "ok",
        "durable": {
            "total": total_memories,
            "active": active_memories,
            "superseded": superseded,
            "metadata_rows": metadata_rows,
            "metadata_coverage": round(metadata_coverage, 4),
        },
        "context": {
            "relations": relations,
            "short_term_turns": short_term_turns,
            "open_tasks_reminders": task_reminders,
        },
        "candidates": candidate_review,
        "policies": {
            "ranking": "phase2-v1",
            "short_term": "ttl_local",
            "candidate_promotion": "explicit_approval",
            "supersession": "non_destructive",
        },
    }

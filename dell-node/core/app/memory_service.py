"""Unified local memory boundary for Alfred Core.

Callers should use this module rather than reaching into SQLite helpers or the
recall index directly. Durable memory records remain editable resources, while
context retrieval can span saved memories, tasks and reminders.
"""

from __future__ import annotations

from . import db
from .recall_store import search as search_context_index


def create_memory(kind: str, content: str, source: str = "api", *, request_id: str | None = None) -> dict:
    clean_kind = kind.strip()[:64]
    clean_content = content.strip()[:4000]
    clean_source = source.strip()[:64] or "api"
    if not clean_kind:
        raise ValueError("Memory kind is required")
    if not clean_content:
        raise ValueError("Memory content is required")
    memory_id = db.remember(clean_kind, clean_content, clean_source)
    db.record_audit(
        "memory.saved",
        {"memory_id": memory_id, "kind": clean_kind, "source": clean_source},
        request_id,
    )
    return db.get_memory(memory_id) or {"id": memory_id, "kind": clean_kind, "content": clean_content, "source": clean_source}


def get_memory(memory_id: int) -> dict | None:
    return db.get_memory(memory_id)


def list_memories(limit: int = 50) -> list[dict]:
    return db.list_memories(max(1, min(limit, 100)))


def search_memories(query: str, limit: int = 8) -> list[dict]:
    """Search durable memory records only, for the Settings/memory resource API."""
    clean = query.strip()[:500]
    if not clean:
        return list_memories(limit)
    return db.recall(clean, max(1, min(limit, 50)))


def retrieve_context(query: str, limit: int = 6) -> list[dict]:
    """Retrieve local context across memories, tasks and reminders."""
    clean = query.strip()[:500]
    if not clean:
        return []
    return search_context_index(clean, max(1, min(limit, 20)))


def correct_memory(memory_id: int, content: str, *, request_id: str | None = None) -> dict | None:
    clean = content.strip()[:4000]
    if not clean:
        raise ValueError("Memory content is required")
    if not db.correct_memory(memory_id, clean):
        return None
    db.record_audit("memory.corrected", {"memory_id": memory_id}, request_id)
    return db.get_memory(memory_id)


def delete_memory(memory_id: int, *, request_id: str | None = None) -> bool:
    if not db.forget(memory_id):
        return False
    db.record_audit("memory.deleted", {"memory_id": memory_id}, request_id)
    return True

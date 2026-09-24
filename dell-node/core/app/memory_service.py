"""Unified local memory boundary for Alfred Core.

Callers should use this module rather than reaching into SQLite helpers or the
recall index directly. Durable memory records remain editable resources, while
context retrieval can span saved memories, tasks and reminders.
"""

from __future__ import annotations

import sqlite3

from . import db
from .memory_context import (
    build_context_pack as build_ranked_context_pack,
    ensure_memory_metadata,
    get_memory_metadata,
    refresh_memory_metadata,
    set_memory_attributes,
)


def create_memory(kind: str, content: str, source: str = "api", *, request_id: str | None = None) -> dict:
    clean_kind = kind.strip()[:64]
    clean_content = content.strip()[:4000]
    clean_source = source.strip()[:64] or "api"
    if not clean_kind:
        raise ValueError("Memory kind is required")
    if not clean_content:
        raise ValueError("Memory content is required")
    memory_id = db.remember(clean_kind, clean_content, clean_source)
    ensure_memory_metadata(memory_id, clean_kind, clean_content, clean_source)
    db.record_audit(
        "memory.saved",
        {"memory_id": memory_id, "kind": clean_kind, "source": clean_source},
        request_id,
    )
    return db.get_memory(memory_id) or {
        "id": memory_id, "kind": clean_kind, "content": clean_content, "source": clean_source
    }


def get_memory(memory_id: int) -> dict | None:
    return db.get_memory(memory_id)


def get_memory_attributes(memory_id: int) -> dict | None:
    item = db.get_memory(memory_id)
    if item is None:
        return None
    return ensure_memory_metadata(
        memory_id, item["kind"], item["content"], item["source"]
    )


def update_memory_attributes(memory_id: int, *, importance: float | None = None,
                             confidence: float | None = None,
                             memory_type: str | None = None,
                             request_id: str | None = None) -> dict | None:
    item = db.get_memory(memory_id)
    if item is None:
        return None
    ensure_memory_metadata(memory_id, item["kind"], item["content"], item["source"])
    updated = set_memory_attributes(
        memory_id,
        importance=importance,
        confidence=confidence,
        memory_type=memory_type,
    )
    if updated is not None:
        db.record_audit(
            "memory.attributes_updated",
            {
                "memory_id": memory_id,
                "importance": updated["importance"],
                "confidence": updated["confidence"],
                "memory_type": updated["memory_type"],
            },
            request_id,
        )
    return updated


def list_memories(limit: int = 50) -> list[dict]:
    return db.list_memories(max(1, min(limit, 100)))


def search_memories(query: str, limit: int = 8) -> list[dict]:
    """Search durable memory records only, preserving the existing resource API semantics."""
    clean = query.strip()[:500]
    if not clean:
        return list_memories(limit)
    return db.recall(clean, max(1, min(limit, 50)))


def _memory_context(item: dict) -> dict:
    content = item["content"]
    metadata = ensure_memory_metadata(
        item["id"], item["kind"], content, item["source"]
    )
    return {
        "id": f"memory:{item['id']}",
        "kind": "memory",
        "memory_type": metadata["memory_type"],
        "title": content.splitlines()[0][:200],
        "content": content,
        "due": None,
        "completed": False,
        "url": f"/settings?memory={item['id']}",
        "source": item["source"],
        "importance": float(metadata["importance"]),
        "confidence": float(metadata["confidence"]),
        "score": 0.5,
        "score_components": {
            "relevance": 0.5,
            "importance": float(metadata["importance"]),
            "confidence": float(metadata["confidence"]),
            "recency": 0.5,
            "due_boost": 0.0,
        },
    }


def build_context_pack(query: str, limit: int = 6, max_chars: int = 6000) -> dict:
    """Build a deterministic, budgeted Phase-2 context pack.

    If the task/reminder index is temporarily unavailable, Alfred degrades to
    durable-memory-only retrieval rather than failing the whole local request.
    """
    clean = query.strip()[:500]
    if not clean:
        return {
            "items": [],
            "budget": {"max_chars": max_chars, "used_chars": 0, "selected": 0, "candidates": 0},
            "ranking": "phase2-v1",
        }
    size = max(1, min(limit, 20))
    try:
        return build_ranked_context_pack(clean, limit=size, max_chars=max_chars)
    except sqlite3.OperationalError as exc:
        if "inbox_filed" not in str(exc):
            raise
        items = [_memory_context(item) for item in db.recall(clean, size)]
        used = sum(len(item["title"]) + len(item["content"]) + 96 for item in items)
        return {
            "items": items,
            "budget": {
                "max_chars": max_chars,
                "used_chars": min(used, max_chars),
                "selected": len(items),
                "candidates": len(items),
                "degraded": "memory_only",
            },
            "ranking": "phase2-v1-fallback",
        }


def retrieve_context(query: str, limit: int = 6) -> list[dict]:
    """Compatibility wrapper returning only the selected context items."""
    return build_context_pack(query, limit=limit)["items"]


def correct_memory(memory_id: int, content: str, *, request_id: str | None = None) -> dict | None:
    clean = content.strip()[:4000]
    if not clean:
        raise ValueError("Memory content is required")
    existing = db.get_memory(memory_id)
    if existing is None or not db.correct_memory(memory_id, clean):
        return None
    refresh_memory_metadata(memory_id, existing["kind"], clean, existing["source"])
    db.record_audit("memory.corrected", {"memory_id": memory_id}, request_id)
    return db.get_memory(memory_id)


def delete_memory(memory_id: int, *, request_id: str | None = None) -> bool:
    if not db.forget(memory_id):
        return False
    db.record_audit("memory.deleted", {"memory_id": memory_id}, request_id)
    return True

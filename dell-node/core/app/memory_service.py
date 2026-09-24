"""Unified local memory boundary for Alfred Core.

Callers should use this module rather than reaching into SQLite helpers or the
recall index directly. Durable memory records remain editable resources, while
context retrieval can span saved memories, tasks, reminders and derived local
memory relationships.
"""

from __future__ import annotations

import sqlite3

from . import db
from . import memory_candidates
from .memory_context import (
    build_context_pack as build_ranked_context_pack,
    ensure_memory_metadata,
    get_memory_metadata,
    refresh_memory_metadata,
    set_memory_attributes,
)
from .memory_graph import expand_context_pack, refresh_relations, relations_for, remove_relations


def create_memory(kind: str, content: str, source: str = "api", *, request_id: str | None = None) -> dict:
    clean_kind = kind.strip()[:64]
    clean_content = content.strip()[:4000]
    clean_source = source.strip()[:64] or "api"
    if not clean_kind:
        raise ValueError("Memory kind is required")
    if not clean_content:
        raise ValueError("Memory content is required")

    duplicate = memory_candidates.find_exact_duplicate(clean_content)
    if duplicate is not None:
        ensure_memory_metadata(
            duplicate["id"], duplicate["kind"], duplicate["content"], duplicate["source"]
        )
        attempted_memory_id = None
        # Preserve an exact repeated durable write as inactive history so the
        # ranker still proves its own duplicate suppression. Cosmetic variants
        # (case/whitespace only) do not need another stored row.
        if duplicate["content"] == clean_content:
            attempted_memory_id = db.remember(clean_kind, clean_content, clean_source)
            ensure_memory_metadata(attempted_memory_id, clean_kind, clean_content, clean_source)
            set_memory_attributes(
                attempted_memory_id,
                importance=0.0,
                confidence=0.0,
                memory_type=clean_kind,
            )
            memory_candidates.mark_superseded(
                attempted_memory_id,
                duplicate["id"],
                reason="duplicate_suppression",
            )
        db.record_audit(
            "memory.duplicate_suppressed",
            {
                "memory_id": duplicate["id"],
                "kind": duplicate["kind"],
                "attempted_memory_id": attempted_memory_id,
            },
            request_id,
        )
        return duplicate

    memory_id = db.remember(clean_kind, clean_content, clean_source)
    ensure_memory_metadata(memory_id, clean_kind, clean_content, clean_source)
    refresh_relations(memory_id)
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


def get_memory_relations(memory_id: int, limit: int = 20) -> list[dict]:
    if db.get_memory(memory_id) is None:
        return []
    refresh_relations(memory_id)
    return relations_for(memory_id, limit)


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


def propose_memory_candidate(
    content: str,
    *,
    memory_type: str = "fact",
    source: str = "local-context",
    source_request_id: str | None = None,
    source_conversation_id: str | None = None,
    confidence: float = 0.8,
    request_id: str | None = None,
) -> dict:
    candidate = memory_candidates.propose(
        content,
        memory_type=memory_type,
        source=source,
        source_request_id=source_request_id,
        source_conversation_id=source_conversation_id,
        confidence=confidence,
    )
    db.record_audit(
        "memory.candidate_proposed",
        {
            "candidate_id": candidate["id"],
            "state": candidate["state"],
            "duplicate_memory_id": candidate.get("duplicate_memory_id"),
            "conflict_memory_id": candidate.get("conflict_memory_id"),
        },
        request_id,
        source_conversation_id,
    )
    return candidate


def get_memory_candidate(candidate_id: str) -> dict | None:
    return memory_candidates.get(candidate_id)


def list_memory_candidates(state: str | None = None, limit: int = 50) -> list[dict]:
    return memory_candidates.list_candidates(state, limit)


def dismiss_memory_candidate(candidate_id: str, *, request_id: str | None = None) -> dict | None:
    candidate = memory_candidates.dismiss(candidate_id)
    if candidate is not None:
        db.record_audit(
            "memory.candidate_dismissed",
            {"candidate_id": candidate_id, "state": candidate["state"]},
            request_id,
        )
    return candidate


def promote_memory_candidate(
    candidate_id: str,
    *,
    supersede_memory_id: int | None = None,
    request_id: str | None = None,
) -> dict:
    candidate = memory_candidates.validate_promotion(candidate_id, supersede_memory_id)
    if candidate["state"] == "promoted":
        memory_id = candidate.get("promoted_memory_id")
        item = db.get_memory(memory_id) if isinstance(memory_id, int) else None
        return {
            "candidate": candidate,
            "memory": item,
            "superseded_memory_id": supersede_memory_id,
        }

    item = create_memory(
        candidate["memory_type"],
        candidate["content"],
        f"candidate:{candidate['source']}"[:64],
        request_id=request_id,
    )
    promoted = memory_candidates.mark_promoted(
        candidate_id,
        item["id"],
        supersede_memory_id,
    )
    if supersede_memory_id is not None and supersede_memory_id != item["id"]:
        remove_relations(supersede_memory_id)
        refresh_relations(item["id"])
    db.record_audit(
        "memory.candidate_promoted",
        {
            "candidate_id": candidate_id,
            "memory_id": item["id"],
            "superseded_memory_id": supersede_memory_id,
        },
        request_id,
    )
    return {
        "candidate": promoted,
        "memory": item,
        "superseded_memory_id": supersede_memory_id,
    }


def list_memories(limit: int = 50) -> list[dict]:
    return db.list_memories(max(1, min(limit, 100)))


def search_memories(query: str, limit: int = 8) -> list[dict]:
    """Search active durable memory records only."""
    clean = query.strip()[:500]
    rows = list_memories(limit) if not clean else db.recall(clean, max(1, min(limit * 2, 100)))
    superseded = memory_candidates.superseded_memory_ids()
    active = [item for item in rows if int(item["id"]) not in superseded]
    return active[:max(1, min(limit, 50))]


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

    Direct lexical matches are ranked first. Tightly related memories can then
    be added through Alfred's local, rebuildable memory graph while remaining
    inside the same item and character budgets. Superseded memories are filtered
    at the unified boundary so historical facts remain auditable but inactive.
    """
    clean = query.strip()[:500]
    if not clean:
        return {
            "items": [],
            "budget": {"max_chars": max_chars, "used_chars": 0, "selected": 0, "candidates": 0},
            "ranking": "phase2-v1",
            "graph": {"expanded": 0, "relations_considered": 0},
        }
    size = max(1, min(limit, 20))
    candidate_size = max(size, min(20, size * 2))
    try:
        pack = build_ranked_context_pack(clean, limit=candidate_size, max_chars=max_chars)
    except sqlite3.OperationalError as exc:
        if "inbox_filed" not in str(exc):
            raise
        items = [_memory_context(item) for item in db.recall(clean, candidate_size)]
        used = sum(len(item["title"]) + len(item["content"]) + 96 for item in items)
        pack = {
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
    expanded = expand_context_pack(pack, limit=candidate_size, max_chars=max_chars)
    active = memory_candidates.filter_active_context(expanded.get("items", []))[:size]
    result = dict(expanded)
    result["items"] = active
    budget = dict(result.get("budget") or {})
    budget["selected"] = len(active)
    result["budget"] = budget
    if len(active) != len(expanded.get("items", [])):
        result["supersession"] = {
            "filtered": len(expanded.get("items", [])) - len(active)
        }
    return result


def retrieve_context(query: str, limit: int = 6) -> list[dict]:
    """Compatibility wrapper returning only the selected active context items."""
    return build_context_pack(query, limit=limit)["items"]


def correct_memory(memory_id: int, content: str, *, request_id: str | None = None) -> dict | None:
    clean = content.strip()[:4000]
    if not clean:
        raise ValueError("Memory content is required")
    existing = db.get_memory(memory_id)
    if existing is None or not db.correct_memory(memory_id, clean):
        return None
    refresh_memory_metadata(memory_id, existing["kind"], clean, existing["source"])
    refresh_relations(memory_id)
    db.record_audit("memory.corrected", {"memory_id": memory_id}, request_id)
    return db.get_memory(memory_id)


def delete_memory(memory_id: int, *, request_id: str | None = None) -> bool:
    remove_relations(memory_id)
    if not db.forget(memory_id):
        return False
    memory_candidates.remove_memory_references(memory_id)
    db.record_audit("memory.deleted", {"memory_id": memory_id}, request_id)
    return True

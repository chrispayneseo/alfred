"""Phase 2 memory ranking and context-pack assembly.

This module is deliberately local and deterministic. Models do not decide what
Alfred remembers or what context is selected for a request.
"""

from __future__ import annotations

import hashlib
import math
import re
from datetime import date, datetime, timezone
from typing import Any

from .db import connection
from .recall_store import local_today, requested_list, search as legacy_search, search_expression


MEMORY_IMPORTANCE = {
    "identity": 0.95,
    "constraint": 0.90,
    "preference": 0.85,
    "person": 0.80,
    "project": 0.75,
    "fact": 0.65,
    "note": 0.55,
}

SOURCE_CONFIDENCE = {
    "user": 1.0,
    "manual": 1.0,
    "api": 1.0,
    "settings": 1.0,
    "whatsapp": 0.90,
    "core-executor": 0.95,
    "inferred": 0.65,
    "model": 0.60,
}


def normalise_text(value: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", value.casefold(), re.UNICODE))


def fingerprint(value: str) -> str:
    return hashlib.sha256(normalise_text(value).encode("utf-8")).hexdigest()


def default_importance(kind: str) -> float:
    return MEMORY_IMPORTANCE.get(kind.casefold(), 0.55)


def default_confidence(source: str) -> float:
    lowered = source.casefold()
    for prefix, score in SOURCE_CONFIDENCE.items():
        if lowered == prefix or lowered.startswith(prefix + ":") or lowered.startswith(prefix + "-"):
            return score
    return 0.85


def ensure_memory_metadata(memory_id: int, kind: str, content: str, source: str) -> dict:
    """Create/hydrate metadata for new and pre-Phase-2 memories."""
    content_fingerprint = fingerprint(content)
    importance = default_importance(kind)
    confidence = default_confidence(source)
    with connection() as db:
        row = db.execute(
            "SELECT * FROM memory_metadata WHERE memory_id = ?",
            (memory_id,),
        ).fetchone()
        if row is None:
            db.execute(
                """INSERT INTO memory_metadata
                   (memory_id, memory_type, importance, confidence, fingerprint)
                   VALUES (?, ?, ?, ?, ?)""",
                (memory_id, kind, importance, confidence, content_fingerprint),
            )
        elif row["fingerprint"] is None:
            # Rows backfilled by the schema migration have neutral defaults. On
            # first use, enrich them deterministically from existing data.
            db.execute(
                """UPDATE memory_metadata
                   SET memory_type = ?, importance = ?, confidence = ?, fingerprint = ?,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE memory_id = ?""",
                (kind, importance, confidence, content_fingerprint, memory_id),
            )
        row = db.execute("SELECT * FROM memory_metadata WHERE memory_id = ?", (memory_id,)).fetchone()
    return dict(row)


def refresh_memory_metadata(memory_id: int, kind: str, content: str, source: str) -> dict:
    """Refresh content-derived metadata without discarding owner-set weights."""
    existing = ensure_memory_metadata(memory_id, kind, content, source)
    with connection() as db:
        db.execute(
            """UPDATE memory_metadata
               SET memory_type = ?, fingerprint = ?, updated_at = CURRENT_TIMESTAMP
               WHERE memory_id = ?""",
            (kind, fingerprint(content), memory_id),
        )
        row = db.execute("SELECT * FROM memory_metadata WHERE memory_id = ?", (memory_id,)).fetchone()
    return dict(row) if row else existing


def get_memory_metadata(memory_id: int) -> dict | None:
    with connection() as db:
        row = db.execute("SELECT * FROM memory_metadata WHERE memory_id = ?", (memory_id,)).fetchone()
    return dict(row) if row else None


def set_memory_attributes(memory_id: int, *, importance: float | None = None,
                          confidence: float | None = None,
                          memory_type: str | None = None) -> dict | None:
    """Update owner-controlled memory attributes; values are strictly bounded."""
    updates: list[str] = []
    params: list[Any] = []
    if importance is not None:
        if not 0 <= importance <= 1:
            raise ValueError("importance must be between 0 and 1")
        updates.append("importance = ?")
        params.append(float(importance))
    if confidence is not None:
        if not 0 <= confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")
        updates.append("confidence = ?")
        params.append(float(confidence))
    if memory_type is not None:
        clean_type = memory_type.strip().casefold()[:64]
        if not clean_type:
            raise ValueError("memory_type is required")
        updates.append("memory_type = ?")
        params.append(clean_type)
    if not updates:
        return get_memory_metadata(memory_id)
    params.append(memory_id)
    with connection() as db:
        result = db.execute(
            f"UPDATE memory_metadata SET {', '.join(updates)}, updated_at = CURRENT_TIMESTAMP WHERE memory_id = ?",
            tuple(params),
        )
        if not result.rowcount:
            return None
        row = db.execute("SELECT * FROM memory_metadata WHERE memory_id = ?", (memory_id,)).fetchone()
    return dict(row)


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _recency_score(created_at: str | None, half_life_days: float = 180.0) -> float:
    parsed = _parse_datetime(created_at)
    if parsed is None:
        return 0.5
    age_days = max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds() / 86400)
    return max(0.05, math.exp(-math.log(2) * age_days / half_life_days))


def _due_boost(due: str | None) -> float:
    if not due:
        return 0.0
    try:
        days = (date.fromisoformat(due) - date.fromisoformat(local_today())).days
    except ValueError:
        return 0.0
    if days < 0:
        return 0.02
    if days <= 1:
        return 0.16
    if days <= 7:
        return 0.12
    if days <= 30:
        return 0.06
    return 0.0


def _rank_score(*, relevance: float, importance: float, confidence: float,
                recency: float, due_boost: float = 0.0) -> tuple[float, dict]:
    components = {
        "relevance": round(relevance, 4),
        "importance": round(importance, 4),
        "confidence": round(confidence, 4),
        "recency": round(recency, 4),
        "due_boost": round(due_boost, 4),
    }
    score = (
        relevance * 0.55
        + importance * 0.20
        + confidence * 0.15
        + recency * 0.10
        + due_boost
    )
    return round(min(score, 1.0), 6), components


def _memory_candidate(row, position: int) -> dict:
    item = dict(row)
    metadata = ensure_memory_metadata(
        item["id"], item["kind"], item["content"], item["source"]
    )
    relevance = max(0.35, 1.0 - position * 0.07)
    recency = _recency_score(item.get("created_at"), 180.0)
    score, components = _rank_score(
        relevance=relevance,
        importance=float(metadata["importance"]),
        confidence=float(metadata["confidence"]),
        recency=recency,
    )
    content = item["content"]
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
        "created_at": item.get("created_at"),
        "importance": float(metadata["importance"]),
        "confidence": float(metadata["confidence"]),
        "score": score,
        "score_components": components,
        "fingerprint": metadata["fingerprint"] or fingerprint(content),
    }


def _item_candidate(row, position: int) -> dict:
    item = dict(row)
    kind = item["kind"]
    relevance = max(0.35, 1.0 - position * 0.07)
    importance = 0.78 if kind == "reminder" else 0.70
    recency = _recency_score(item.get("created_at"), 60.0)
    boost = _due_boost(item.get("due"))
    score, components = _rank_score(
        relevance=relevance,
        importance=importance,
        confidence=1.0,
        recency=recency,
        due_boost=boost,
    )
    content = item.get("detail") or ""
    combined = f"{item['title']}\n{content}".strip()
    return {
        "id": f"item:{item['source_id']}",
        "kind": kind,
        "memory_type": kind,
        "title": item["title"],
        "content": content,
        "due": item.get("due"),
        "completed": bool(item.get("completed_at")),
        "url": f"/today?localItem={item['source_id']}",
        "source": "inbox_filed",
        "created_at": item.get("created_at"),
        "importance": importance,
        "confidence": 1.0,
        "score": score,
        "score_components": components,
        "fingerprint": fingerprint(combined),
    }


def _general_candidates(query: str, candidate_limit: int) -> list[dict]:
    expression = search_expression(query)
    if not expression:
        return []
    with connection() as db:
        memories = db.execute(
            """SELECT m.id, m.created_at, m.kind, m.content, m.source, bm25(memories_fts) AS fts_rank
               FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
               WHERE memories_fts MATCH ? ORDER BY fts_rank LIMIT ?""",
            (expression, candidate_limit),
        ).fetchall()
        items = db.execute(
            """SELECT i.source_id, i.kind, i.title, i.detail, i.due, i.completed_at,
                      i.created_at, bm25(inbox_filed_fts) AS fts_rank
               FROM inbox_filed_fts JOIN inbox_filed i ON i.rowid = inbox_filed_fts.rowid
               WHERE inbox_filed_fts MATCH ? AND i.kind IN ('task', 'reminder')
               ORDER BY fts_rank LIMIT ?""",
            (expression, candidate_limit),
        ).fetchall()
    candidates = [_memory_candidate(row, index) for index, row in enumerate(memories)]
    candidates.extend(_item_candidate(row, index) for index, row in enumerate(items))
    return candidates


def _list_candidates(query: str, limit: int) -> list[dict]:
    # Preserve established due-date/list semantics, then attach deterministic
    # Phase-2 scoring metadata.
    legacy = legacy_search(query, min(limit, 20))
    candidates: list[dict] = []
    for index, item in enumerate(legacy):
        relevance = max(0.4, 1.0 - index * 0.05)
        importance = 0.78 if item["kind"] == "reminder" else 0.70
        score, components = _rank_score(
            relevance=relevance,
            importance=importance,
            confidence=1.0,
            recency=0.8,
            due_boost=_due_boost(item.get("due")),
        )
        enriched = dict(item)
        combined = f"{item.get('title', '')}\n{item.get('content', '')}".strip()
        enriched.update({
            "memory_type": item["kind"],
            "source": "inbox_filed",
            "importance": importance,
            "confidence": 1.0,
            "score": score,
            "score_components": components,
            "fingerprint": fingerprint(combined),
        })
        candidates.append(enriched)
    return candidates


def _deduplicate(candidates: list[dict]) -> list[dict]:
    best: dict[str, dict] = {}
    for item in candidates:
        key = item.get("fingerprint") or fingerprint(
            f"{item.get('title', '')}\n{item.get('content', '')}"
        )
        current = best.get(key)
        if current is None or float(item.get("score", 0)) > float(current.get("score", 0)):
            best[key] = item
    return sorted(best.values(), key=lambda item: (-float(item.get("score", 0)), item.get("id", "")))


def _apply_budget(candidates: list[dict], limit: int, max_chars: int) -> tuple[list[dict], int]:
    selected: list[dict] = []
    used = 0
    for candidate in candidates:
        if len(selected) >= limit or used >= max_chars:
            break
        item = dict(candidate)
        # No single source should consume the entire model context.
        content = str(item.get("content") or "")[:1600]
        title = str(item.get("title") or "")[:200]
        overhead = len(title) + 96
        available = max_chars - used - overhead
        if available <= 0:
            break
        if len(content) > available:
            if available < 80:
                continue
            content = content[:available].rstrip() + "…"
        item["content"] = content
        item.pop("fingerprint", None)
        selected.append(item)
        used += overhead + len(content)
    return selected, used


def _record_access(items: list[dict]) -> None:
    memory_ids = []
    for item in items:
        value = str(item.get("id", ""))
        if value.startswith("memory:"):
            try:
                memory_ids.append(int(value.split(":", 1)[1]))
            except ValueError:
                continue
    if not memory_ids:
        return
    with connection() as db:
        db.executemany(
            """UPDATE memory_metadata
               SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP
               WHERE memory_id = ?""",
            [(memory_id,) for memory_id in memory_ids],
        )


def build_context_pack(query: str, *, limit: int = 6, max_chars: int = 6000) -> dict:
    clean = query.strip()[:500]
    if not clean:
        return {
            "items": [],
            "budget": {"max_chars": max_chars, "used_chars": 0, "selected": 0, "candidates": 0},
            "ranking": "phase2-v1",
        }
    size = max(1, min(limit, 20))
    budget = max(512, min(max_chars, 24000))
    if requested_list(clean):
        candidates = _list_candidates(clean, max(size * 3, size))
    else:
        candidates = _general_candidates(clean, max(size * 4, 12))
    ranked = _deduplicate(candidates)
    selected, used = _apply_budget(ranked, size, budget)
    _record_access(selected)
    return {
        "items": selected,
        "budget": {
            "max_chars": budget,
            "used_chars": used,
            "selected": len(selected),
            "candidates": len(candidates),
            "deduplicated_candidates": len(ranked),
        },
        "ranking": "phase2-v1",
    }

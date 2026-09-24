"""Deterministic local relationships between durable memories.

Relations are derived metadata: they can be rebuilt from memory content and are
never treated as user-authored facts. No model is used to create graph edges.
"""

from __future__ import annotations

import re
from collections import defaultdict

from .db import connection


STOPWORDS = {
    "about", "after", "again", "also", "and", "are", "because", "been", "before",
    "being", "but", "can", "contains", "could", "does", "for", "from", "have", "into",
    "its", "just", "more", "not", "our", "that", "the", "their", "them", "then", "there",
    "these", "this", "those", "was", "were", "what", "when", "where", "which", "with",
    "would", "your",
}

RELATION = "lexical_overlap"
MIN_SHARED_TERMS = 2
MIN_SIMILARITY = 0.24


def _terms(value: str) -> set[str]:
    return {
        term
        for term in re.findall(r"[^\W_]{3,}", value.casefold(), re.UNICODE)
        if term not in STOPWORDS
    }


def similarity(left: str, right: str) -> tuple[float, int]:
    a = _terms(left)
    b = _terms(right)
    if not a or not b:
        return 0.0, 0
    shared = len(a & b)
    union = len(a | b)
    return (shared / union if union else 0.0), shared


def remove_relations(memory_id: int) -> None:
    with connection() as db:
        db.execute(
            "DELETE FROM memory_relations WHERE from_memory_id = ? OR to_memory_id = ?",
            (memory_id, memory_id),
        )


def refresh_relations(memory_id: int, *, comparison_limit: int = 1000) -> int:
    """Rebuild deterministic edges touching one memory."""
    with connection() as db:
        current = db.execute(
            "SELECT id, content FROM memories WHERE id = ?",
            (memory_id,),
        ).fetchone()
        if current is None:
            db.execute(
                "DELETE FROM memory_relations WHERE from_memory_id = ? OR to_memory_id = ?",
                (memory_id, memory_id),
            )
            return 0
        others = db.execute(
            "SELECT id, content FROM memories WHERE id != ? ORDER BY id DESC LIMIT ?",
            (memory_id, max(1, min(comparison_limit, 5000))),
        ).fetchall()
        db.execute(
            "DELETE FROM memory_relations WHERE from_memory_id = ? OR to_memory_id = ?",
            (memory_id, memory_id),
        )
        inserted = 0
        for other in others:
            score, shared = similarity(current["content"], other["content"])
            if shared < MIN_SHARED_TERMS or score < MIN_SIMILARITY:
                continue
            # Exact duplicates are already handled by context deduplication and
            # do not need a second graph edge.
            if score >= 0.999:
                continue
            left, right = sorted((memory_id, int(other["id"])))
            confidence = min(0.95, 0.5 + score)
            db.execute(
                """INSERT OR REPLACE INTO memory_relations
                   (from_memory_id, to_memory_id, relation, confidence)
                   VALUES (?, ?, ?, ?)""",
                (left, right, RELATION, confidence),
            )
            inserted += 1
    return inserted


def relations_for(memory_id: int, limit: int = 20) -> list[dict]:
    with connection() as db:
        rows = db.execute(
            """SELECT r.id, r.from_memory_id, r.to_memory_id, r.relation, r.confidence,
                      r.created_at,
                      CASE WHEN r.from_memory_id = ? THEN r.to_memory_id ELSE r.from_memory_id END AS related_memory_id
               FROM memory_relations r
               WHERE r.from_memory_id = ? OR r.to_memory_id = ?
               ORDER BY r.confidence DESC, r.id DESC LIMIT ?""",
            (memory_id, memory_id, memory_id, max(1, min(limit, 100))),
        ).fetchall()
    return [dict(row) for row in rows]


def _memory_id(item: dict) -> int | None:
    value = str(item.get("id", ""))
    if not value.startswith("memory:"):
        return None
    try:
        return int(value.split(":", 1)[1])
    except ValueError:
        return None


def expand_context_pack(pack: dict, *, limit: int, max_chars: int) -> dict:
    """Add tightly related memories while respecting the existing hard budget."""
    direct = [dict(item) for item in pack.get("items", [])]
    selected_ids = {value for item in direct if (value := _memory_id(item)) is not None}
    if not selected_ids or len(direct) >= limit:
        result = dict(pack)
        result["graph"] = {"expanded": 0, "relations_considered": 0}
        return result

    # Lazily hydrate the graph for old memories when they first become relevant.
    for memory_id in selected_ids:
        refresh_relations(memory_id)

    parent_scores = {
        memory_id: float(item.get("score", 0.5))
        for item in direct
        if (memory_id := _memory_id(item)) is not None
    }
    related_best: dict[int, dict] = {}
    considered = 0

    with connection() as db:
        for parent_id in selected_ids:
            rows = db.execute(
                """SELECT r.relation, r.confidence,
                          CASE WHEN r.from_memory_id = ? THEN r.to_memory_id ELSE r.from_memory_id END AS related_id,
                          m.created_at, m.kind, m.content, m.source,
                          mm.memory_type, mm.importance, mm.confidence AS memory_confidence
                   FROM memory_relations r
                   JOIN memories m ON m.id = CASE WHEN r.from_memory_id = ? THEN r.to_memory_id ELSE r.from_memory_id END
                   LEFT JOIN memory_metadata mm ON mm.memory_id = m.id
                   WHERE (r.from_memory_id = ? OR r.to_memory_id = ?)
                   ORDER BY r.confidence DESC LIMIT 12""",
                (parent_id, parent_id, parent_id, parent_id),
            ).fetchall()
            for row in rows:
                considered += 1
                related_id = int(row["related_id"])
                if related_id in selected_ids:
                    continue
                parent_score = parent_scores.get(parent_id, 0.5)
                relation_confidence = float(row["confidence"])
                score = round(min(0.89, parent_score * relation_confidence * 0.9), 6)
                content = row["content"]
                candidate = {
                    "id": f"memory:{related_id}",
                    "kind": "memory",
                    "memory_type": row["memory_type"] or row["kind"],
                    "title": content.splitlines()[0][:200],
                    "content": content,
                    "due": None,
                    "completed": False,
                    "url": f"/settings?memory={related_id}",
                    "source": row["source"],
                    "created_at": row["created_at"],
                    "importance": float(row["importance"] if row["importance"] is not None else 0.55),
                    "confidence": float(row["memory_confidence"] if row["memory_confidence"] is not None else 0.85),
                    "score": score,
                    "score_components": {
                        "relation": relation_confidence,
                        "parent_score": parent_score,
                    },
                    "relation": {
                        "type": row["relation"],
                        "from_memory_id": parent_id,
                        "confidence": relation_confidence,
                    },
                }
                current = related_best.get(related_id)
                if current is None or score > float(current.get("score", 0)):
                    related_best[related_id] = candidate

    candidates = sorted(related_best.values(), key=lambda item: (-float(item["score"]), item["id"]))
    budget = dict(pack.get("budget") or {})
    used = int(budget.get("used_chars") or 0)
    budget_cap = max(512, min(max_chars, 24000))
    expanded = 0

    for candidate in candidates:
        if len(direct) >= limit or used >= budget_cap:
            break
        item = dict(candidate)
        title = str(item.get("title") or "")[:200]
        content = str(item.get("content") or "")[:1200]
        overhead = len(title) + 112
        available = budget_cap - used - overhead
        if available <= 0:
            break
        if len(content) > available:
            if available < 80:
                continue
            content = content[: max(0, available - 1)].rstrip() + "…"
        item["content"] = content
        direct.append(item)
        used += overhead + len(content)
        expanded += 1

    direct.sort(key=lambda item: (-float(item.get("score", 0)), item.get("id", "")))
    budget["max_chars"] = budget_cap
    budget["used_chars"] = used
    budget["selected"] = len(direct)
    result = dict(pack)
    result["items"] = direct
    result["budget"] = budget
    result["graph"] = {"expanded": expanded, "relations_considered": considered}
    return result

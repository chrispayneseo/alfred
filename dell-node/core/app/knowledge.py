"""Phase 9 deep memory and personal knowledge.

This is a deterministic local knowledge overlay on top of Alfred's already
approved durable memory. It does not auto-save model output, connected-account
payloads or transient conversation turns. Provenance and confidence remain
visible, superseded memories remain auditable but inactive, and unresolved
memory conflicts are surfaced for owner review rather than silently reconciled.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from . import memory_candidates, memory_service
from .db import connection
from .memory_context import ensure_memory_metadata
from .memory_graph import relations_for, refresh_relations

MODE = "deep_personal_knowledge_v1"
CONTENT_POLICY = "approved_local_memory_only"
router = APIRouter(tags=["core-personal-knowledge"])
ENTITY_RE = re.compile(r"\b(?:[A-Z][a-z]{2,})(?:\s+[A-Z][a-z]{2,}){0,2}\b")
GENERIC_ENTITIES = {"The", "This", "That", "Alfred", "Core", "Phase"}


def _active_memory_rows(limit: int = 500) -> list[dict]:
    memory_candidates.initialise()
    with connection() as db:
        rows = db.execute(
            """SELECT m.id, m.kind, m.content, m.source, m.created_at
               FROM memories m
               LEFT JOIN memory_supersessions s ON s.memory_id = m.id
               WHERE s.memory_id IS NULL
               ORDER BY m.id DESC LIMIT ?""",
            (max(1, min(limit, 2000)),),
        ).fetchall()
    return [dict(row) for row in rows]


def _metadata(item: dict) -> dict:
    return ensure_memory_metadata(
        int(item["id"]), str(item["kind"]), str(item["content"]), str(item["source"])
    )


def _age_days(created_at: str | None) -> int | None:
    if not created_at:
        return None
    try:
        parsed = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0, (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).days)
    except ValueError:
        return None


def _age_band(days: int | None) -> str:
    if days is None:
        return "unknown"
    if days <= 30:
        return "recent"
    if days <= 180:
        return "established"
    if days <= 365:
        return "old"
    return "stale_review_candidate"


def _entities(content: str) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for match in ENTITY_RE.findall(content[:4000]):
        clean = match.strip()
        if clean in GENERIC_ENTITIES or clean.casefold() in seen:
            continue
        seen.add(clean.casefold())
        found.append(clean)
    return found[:12]


def _claim(item: dict, *, include_content: bool = True) -> dict:
    metadata = _metadata(item)
    age = _age_days(item.get("created_at"))
    payload = {
        "id": f"memory:{item['id']}",
        "memory_id": int(item["id"]),
        "memory_type": str(metadata.get("memory_type") or item["kind"]),
        "source": str(item["source"]),
        "provenance": f"durable_memory:{item['id']}",
        "confidence": float(metadata.get("confidence", 0.0)),
        "importance": float(metadata.get("importance", 0.0)),
        "created_at": item.get("created_at"),
        "age_days": age,
        "age_band": _age_band(age),
        "entities": _entities(str(item["content"])),
        "active": True,
    }
    if include_content:
        payload["content"] = str(item["content"])[:2000]
    return payload


def entity_index(limit: int = 100) -> list[dict]:
    counts: Counter[str] = Counter()
    display: dict[str, str] = {}
    memories: defaultdict[str, list[int]] = defaultdict(list)
    for item in _active_memory_rows():
        for entity in _entities(str(item["content"])):
            key = entity.casefold()
            counts[key] += 1
            display.setdefault(key, entity)
            if len(memories[key]) < 8:
                memories[key].append(int(item["id"]))
    return [
        {"entity": display[key], "memory_count": count, "memory_ids": memories[key]}
        for key, count in counts.most_common(max(1, min(limit, 200)))
    ]


def search(query: str, limit: int = 10) -> dict:
    clean = query.strip()[:500]
    if not clean:
        return {"mode": MODE, "query": "", "items": [], "cloud_models": False}
    pack = memory_service.build_context_pack(clean, limit=max(1, min(limit, 20)), max_chars=8000)
    rows = {int(row["id"]): row for row in _active_memory_rows(1000)}
    items: list[dict] = []
    for context in pack.get("items", []):
        raw_id = context.get("id")
        if context.get("kind") == "memory" and isinstance(raw_id, str) and raw_id.startswith("memory:"):
            try:
                memory_id = int(raw_id.split(":", 1)[1])
            except ValueError:
                continue
            source = rows.get(memory_id)
            if source is not None:
                claim = _claim(source)
                claim["relation"] = "direct_or_graph_context"
                items.append(claim)
        else:
            items.append({
                "id": raw_id,
                "memory_type": context.get("kind"),
                "source": context.get("source"),
                "provenance": f"local_context:{raw_id}",
                "confidence": float(context.get("confidence", 1.0)),
                "importance": float(context.get("importance", 0.5)),
                "content": str(context.get("content") or context.get("title") or "")[:1000],
                "due": context.get("due"),
                "active": not bool(context.get("completed")),
                "entities": _entities(str(context.get("content") or context.get("title") or "")),
                "relation": "local_task_or_reminder_context",
            })
    return {
        "mode": MODE,
        "query": clean,
        "items": items[:max(1, min(limit, 20))],
        "ranking": pack.get("ranking"),
        "graph": pack.get("graph", {}),
        "cloud_models": False,
        "connected_payload_indexed": False,
    }


def decision_history(limit: int = 50) -> list[dict]:
    rows: list[dict] = []
    for item in _active_memory_rows(1000):
        metadata = _metadata(item)
        memory_type = str(metadata.get("memory_type") or item["kind"]).casefold()
        if memory_type not in {"decision", "preference", "constraint"}:
            continue
        rows.append(_claim(item))
        if len(rows) >= max(1, min(limit, 100)):
            break
    return rows


def contradictions(limit: int = 50) -> list[dict]:
    candidates = memory_service.list_memory_candidates("conflict", max(1, min(limit, 100)))
    items: list[dict] = []
    for candidate in candidates:
        items.append({
            "candidate_id": candidate["id"],
            "candidate_content": str(candidate.get("content") or "")[:1000],
            "candidate_type": candidate.get("memory_type"),
            "candidate_confidence": float(candidate.get("confidence", 0.0)),
            "conflict_memory_id": candidate.get("conflict_memory_id"),
            "state": "owner_review_required",
            "created_at": candidate.get("created_at"),
            "provenance": str(candidate.get("source") or "local-context"),
        })
    return items


def entity_view(entity: str, limit: int = 20) -> dict:
    clean = entity.strip()[:120]
    if not clean:
        raise ValueError("Entity is required")
    matches: list[dict] = []
    for item in _active_memory_rows(1000):
        entities = _entities(str(item["content"]))
        if not any(value.casefold() == clean.casefold() for value in entities):
            continue
        refresh_relations(int(item["id"]))
        claim = _claim(item)
        claim["related_memory_ids"] = [
            int(row["related_memory_id"])
            for row in relations_for(int(item["id"]), 8)
            if row.get("related_memory_id") is not None
        ]
        matches.append(claim)
        if len(matches) >= max(1, min(limit, 50)):
            break
    return {"entity": clean, "claims": matches, "claim_count": len(matches)}


def status() -> dict:
    active = _active_memory_rows(2000)
    review = memory_candidates.review_summary(run_maintenance=False)
    types: Counter[str] = Counter()
    stale = 0
    for item in active:
        metadata = _metadata(item)
        types[str(metadata.get("memory_type") or item["kind"])] += 1
        if _age_band(_age_days(item.get("created_at"))) == "stale_review_candidate":
            stale += 1
    return {
        "mode": MODE,
        "content_policy": CONTENT_POLICY,
        "active_memory_count": len(active),
        "memory_types": dict(types),
        "entity_count": len(entity_index(200)),
        "open_conflicts": int(review.get("conflicts", 0)),
        "superseded_memories": int(review.get("superseded_memories", 0)),
        "stale_review_candidates": stale,
        "provenance_preserved": True,
        "confidence_preserved": True,
        "supersession_preserved": True,
        "contradictions_require_owner_review": True,
        "connected_payload_indexed": False,
        "transient_conversation_indexed": False,
        "model_auto_memory": False,
        "cloud_models": False,
        "new_executor": False,
    }


@router.get("/v1/core/knowledge/status")
async def knowledge_status():
    return status()


@router.get("/v1/core/knowledge/search")
async def knowledge_search(q: str = Query(min_length=1, max_length=500), limit: int = 10):
    return search(q, limit)


@router.get("/v1/core/knowledge/entities")
async def knowledge_entities(limit: int = 100):
    return {"mode": MODE, "items": entity_index(limit)}


@router.get("/v1/core/knowledge/entities/{entity}")
async def knowledge_entity(entity: str, limit: int = 20):
    try:
        return entity_view(entity, limit)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/v1/core/knowledge/history")
async def knowledge_history(limit: int = 50):
    return {"mode": MODE, "items": decision_history(limit)}


@router.get("/v1/core/knowledge/contradictions")
async def knowledge_contradictions(limit: int = 50):
    return {"mode": MODE, "items": contradictions(limit)}

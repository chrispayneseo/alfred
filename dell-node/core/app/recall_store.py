"""Local-only retrieval over explicitly saved memories, tasks and reminders."""

from __future__ import annotations

import re
from datetime import datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

from .db import connection


STOPWORDS = {
    "about", "again", "alfred", "are", "can", "could", "did", "do", "does", "for",
    "from", "have", "how", "into", "know", "local", "me", "mine", "much", "my",
    "note", "notes", "of", "on", "our", "please", "recall", "remember", "reminder",
    "reminders", "save", "saved", "say", "said", "show", "tell", "that", "the", "them",
    "there", "these", "thing", "things", "this", "task", "tasks", "told", "was",
    "were", "what", "when", "where", "which", "who", "will", "with", "you", "your",
}


def local_today() -> str:
    return datetime.now(ZoneInfo("Europe/London")).date().isoformat()


def search_expression(query: str) -> str:
    # Never put raw user text into MATCH syntax; quote only tokenizer-safe words.
    terms = [term for term in re.findall(r"[^\W_]{3,}", query.casefold(), re.UNICODE)
             if term not in STOPWORDS]
    return " AND ".join(f'"{term}"' for term in list(dict.fromkeys(terms))[:8])


def recall_intent(query: str) -> bool:
    lowered = query.casefold()
    return bool(re.search(r"\b(what|when|which|who|do you)\b.*\b(remember|recall|save|saved|say|said|tell|told|note|notes|task|tasks|reminder|reminders|my)\b", lowered)
                or re.search(r"\bwhere\b.*\b(is|are|did|do|was|were)\b", lowered)
                or re.search(r"\b(my (notes|tasks|reminders|memory)|reminders? (coming up|due)|tasks? (coming up|due))\b", lowered))


def requested_list(query: str) -> str | None:
    lowered = query.casefold()
    if re.search(r"\b(said|told|save about|saved about|remember about)\b", lowered):
        return None
    if not re.search(r"\b(coming up|upcoming|due|scheduled|what|show|list|my)\b", lowered):
        return None
    if re.search(r"\breminders?\b", lowered):
        return "reminder"
    if re.search(r"\btasks?\b", lowered):
        return "task"
    return None


def _item_source(row) -> dict:
    item = dict(row)
    return {
        "id": f"item:{item['source_id']}", "kind": item["kind"],
        "title": item["title"], "content": item["detail"] or "",
        "due": item["due"], "completed": bool(item["completed_at"]),
        "url": f"/today?localItem={quote(item['source_id'], safe='')}",
    }


def _memory_source(row) -> dict:
    item = dict(row)
    content = item["content"]
    return {
        "id": f"memory:{item['id']}", "kind": "memory", "title": content.splitlines()[0][:200],
        "content": content, "due": None, "completed": False,
        "url": f"/settings?memory={item['id']}",
    }


def search(query: str, limit: int = 6) -> list[dict]:
    kind = requested_list(query)
    with connection() as db:
        if kind:
            upcoming = bool(re.search(r"\b(coming up|upcoming|scheduled)\b", query.casefold()))
            rows = db.execute("""SELECT source_id, kind, title, detail, due, completed_at
                FROM inbox_filed WHERE kind = ? AND completed_at IS NULL
                AND (? = 0 OR due >= ?)
                ORDER BY CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, created_at LIMIT ?""",
                (kind, int(upcoming), local_today(), min(limit, 20))).fetchall()
            return [_item_source(row) for row in rows]

        expression = search_expression(query)
        if not expression:
            return []
        memories = db.execute("""SELECT m.id, m.content FROM memories_fts
            JOIN memories m ON m.id = memories_fts.rowid
            WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?""", (expression, limit)).fetchall()
        items = db.execute("""SELECT i.source_id, i.kind, i.title, i.detail, i.due, i.completed_at
            FROM inbox_filed_fts JOIN inbox_filed i ON i.rowid = inbox_filed_fts.rowid
            WHERE inbox_filed_fts MATCH ? AND i.kind IN ('task', 'reminder')
            ORDER BY rank LIMIT ?""", (expression, limit)).fetchall()
    # The two FTS indexes have separate relevance scores. Alternating types
    # gives both saved memories and action items a fair chance in a short list.
    results = []
    for index in range(max(len(memories), len(items))):
        if index < len(memories):
            results.append(_memory_source(memories[index]))
        if index < len(items):
            results.append(_item_source(items[index]))
    return results[:limit]

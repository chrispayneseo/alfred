"""Conservative deterministic extraction of reviewable memory candidates.

This is intentionally not semantic memory generation. It notices only clearly
stable statement forms, keeps the user's own sentence as evidence/content, and
places it in the local candidate queue. Nothing is promoted automatically.
"""

from __future__ import annotations

import re

from . import memory_service
from .db import record_audit


TRANSIENT_TERMS = {
    "today", "tomorrow", "yesterday", "right now", "currently", "this morning",
    "this afternoon", "this evening", "tonight", "this week", "this weekend",
    "just now", "at the moment",
}

SECRET_PATTERNS = (
    re.compile(r"\bpassword\s*(?:is|=|:)\b", re.I),
    re.compile(r"\bpasscode\s*(?:is|=|:)\b", re.I),
    re.compile(r"\bpin\s*(?:is|=|:)\b", re.I),
    re.compile(r"\b(?:api|secret)\s+key\b", re.I),
    re.compile(r"\brecovery\s+code\b", re.I),
    re.compile(r"\bcvv\b", re.I),
    re.compile(r"\bcard\s+number\b", re.I),
    re.compile(r"\baccount\s+number\b", re.I),
    re.compile(r"\bsort\s+code\b", re.I),
)

PATTERNS: tuple[tuple[str, float, re.Pattern[str]], ...] = (
    (
        "preference",
        0.90,
        re.compile(
            r"^(?:i|we|[A-Z][\w'-]+)\s+(?:really\s+)?(?:like|love|prefer|enjoy|dislike|hate)\b",
            re.I,
        ),
    ),
    (
        "identity",
        0.90,
        re.compile(r"^i\s+(?:am\s+(?:a|an)\b|work\s+(?:as|at|for)\b|live\s+in\b)", re.I),
    ),
    (
        "project",
        0.85,
        re.compile(
            r"^(?:i(?:'m|\s+am)|we(?:'re|\s+are))\s+(?:building|developing|working\s+on)\b",
            re.I,
        ),
    ),
    (
        "fact",
        0.80,
        re.compile(r"^(?:i|we)\s+have\b", re.I),
    ),
    (
        "fact",
        0.82,
        re.compile(r"^my\s+.{1,80}\s+(?:is|are)\b", re.I),
    ),
    (
        "person",
        0.80,
        re.compile(r"^[A-Z][\w'-]+\s+(?:has|uses|likes|loves|prefers|enjoys|dislikes|hates)\b"),
    ),
)


def _sentences(message: str) -> list[str]:
    # Newlines and sentence-ending punctuation are boundaries. Keep the user's
    # actual wording rather than asking a model to paraphrase it into a fact.
    parts = re.split(r"(?:[.!]\s+|\n+)", message.strip())
    return [part.strip().rstrip(".") for part in parts if part.strip()]


def _safe_stable_sentence(sentence: str) -> tuple[str, float] | None:
    if len(sentence) < 8 or len(sentence) > 300 or "?" in sentence:
        return None
    lowered = sentence.casefold()
    if any(term in lowered for term in TRANSIENT_TERMS):
        return None
    if any(pattern.search(sentence) for pattern in SECRET_PATTERNS):
        return None
    for memory_type, confidence, pattern in PATTERNS:
        if pattern.search(sentence):
            return memory_type, confidence
    return None


def extract(message: str, *, limit: int = 3) -> list[dict]:
    """Return grounded candidate proposals without writing any state."""
    results: list[dict] = []
    for sentence in _sentences(message)[:8]:
        classification = _safe_stable_sentence(sentence)
        if classification is None:
            continue
        memory_type, confidence = classification
        results.append({
            "content": sentence,
            "memory_type": memory_type,
            "confidence": confidence,
        })
        if len(results) >= max(1, min(limit, 3)):
            break
    return results


def capture(
    message: str,
    *,
    request_id: str,
    conversation_id: str,
    source: str = "auto-local",
) -> list[dict]:
    """Place stable local statements into the review queue; never promote them."""
    proposed: list[dict] = []
    for item in extract(message):
        candidate = memory_service.propose_memory_candidate(
            item["content"],
            memory_type=item["memory_type"],
            source=source,
            source_request_id=request_id,
            source_conversation_id=conversation_id,
            confidence=item["confidence"],
            request_id=request_id,
        )
        proposed.append(candidate)
    if proposed:
        record_audit(
            "memory.candidate_extraction",
            {
                "count": len(proposed),
                "states": [item["state"] for item in proposed],
            },
            request_id,
            conversation_id,
        )
    return proposed

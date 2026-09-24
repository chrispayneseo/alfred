"""Deterministic privacy classification used before any off-device request."""

from __future__ import annotations

import re


PRIVATE_TERMS = (
    "my email", "my emails", "gmail", "inbox", "calendar", "my schedule",
    "my notes", "my tasks", "notion", "my account", "my contacts", "my files",
    "my memory", "remember about me", "my personal", "my health", "my finances",
)
CONNECTED_TERMS = (
    "my email", "my emails", "gmail", "inbox", "calendar", "my schedule",
    "notion", "my contacts", "my files",
)
CLOUD_TERMS = (
    "research", "latest", "current news", "browse", "search the web",
    "debug", "write code", "implement", "analyse this document", "analyze this document",
)
EXPLICIT_CLOUD_TERMS = (
    "research", "browse", "search the web", "use chatgpt", "use openai",
    "use claude", "send to cloud",
)
WEB_TERMS = (
    "latest", "current", "today", "news", "research", "browse", "search the web",
    "look up", "find online",
)


def is_private(message: str) -> bool:
    lowered = message.casefold()
    return (
        any(term in lowered for term in PRIVATE_TERMS)
        or bool(re.search(r"\b(my|mine|me|i|we|our)\b", lowered))
        or bool(re.search(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b", message))
    )


def needs_connected_data(message: str) -> bool:
    lowered = message.casefold()
    return any(term in lowered for term in CONNECTED_TERMS)


def cloud_requested(message: str) -> bool:
    lowered = message.casefold()
    return any(term in lowered for term in CLOUD_TERMS)


def explicit_cloud(message: str) -> bool:
    lowered = message.casefold()
    return any(term in lowered for term in EXPLICIT_CLOUD_TERMS)


def needs_web_search(message: str) -> bool:
    lowered = message.casefold()
    return any(term in lowered for term in WEB_TERMS)

"""Authoritative Alfred Core request orchestration.

Every first-party channel should converge on this module. Models may classify or
answer, but routing, privacy, permission and audit decisions remain deterministic
Core responsibilities.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from typing import Literal

from .clients import ollama_chat, ollama_route
from .core import normalise_request
from .db import record_audit
from .lifecycle import begin_request, transition_request
from .memory_service import retrieve_context
from .providers import get_provider
from .recall_store import recall_intent

Route = Literal["local", "cloud_ready", "approval_required", "connection_needed"]

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
    "research", "browse", "search the web", "use chatgpt", "use claude", "send to cloud",
)


@dataclass(frozen=True)
class OrchestrationResult:
    request_id: str
    conversation_id: str
    route: Route
    reply: str | None = None
    provider: str | None = None
    reason: str | None = None
    memories_used: int = 0
    sources: list[dict] | None = None
    memory_sent: bool = False
    cloud_prompt: str | None = None

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["decision"] = payload.pop("route")
        if payload["sources"] is None:
            payload.pop("sources")
        if payload["cloud_prompt"] is None:
            payload.pop("cloud_prompt")
        return payload


def _is_private(message: str) -> bool:
    lowered = message.lower()
    return (
        any(term in lowered for term in PRIVATE_TERMS)
        or bool(re.search(r"\b(my|mine|me|i|we|our)\b", lowered))
        or bool(re.search(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b", message))
    )


def _needs_connected_data(message: str) -> bool:
    lowered = message.lower()
    return any(term in lowered for term in CONNECTED_TERMS)


def _cloud_requested(message: str) -> bool:
    lowered = message.lower()
    return any(term in lowered for term in CLOUD_TERMS)


def _explicit_cloud(message: str) -> bool:
    lowered = message.lower()
    return any(term in lowered for term in EXPLICIT_CLOUD_TERMS)


async def orchestrate(
    *,
    channel: str,
    message: str,
    conversation_id: str | None = None,
    recall_answerer=None,
) -> dict:
    """Process a request through Alfred Core's deterministic decision boundary."""
    request = normalise_request(channel, message, conversation_id)
    request_id = request["request_id"]
    conversation_id = request["conversation_id"]
    clean = request["message"]

    begin_request(request)
    transition_request(request_id, "routing")
    record_audit(
        "request.received",
        {"channel": channel, "operation": "orchestrate"},
        request_id,
        conversation_id,
    )

    try:
        if _needs_connected_data(clean):
            result = OrchestrationResult(
                request_id=request_id,
                conversation_id=conversation_id,
                route="connection_needed",
                reason="The requested connected account is not linked to Alfred Core yet.",
                reply="I can't check that connected account from the Dell yet. Its data has not been linked to the local gateway.",
            )
            transition_request(request_id, "connection_needed", route=result.route)
            record_audit("request.routed", {"decision": result.route}, request_id, conversation_id)
            return result.to_dict()

        if recall_intent(clean) and not _explicit_cloud(clean):
            transition_request(request_id, "local_processing", route="local")
            sources = retrieve_context(clean)
            if recall_answerer is None:
                reply = (
                    "I found matching saved information in Alfred's local memory."
                    if sources else
                    "I couldn't find anything matching that in Alfred's local memory, tasks or reminders."
                )
            else:
                reply = await recall_answerer(clean, sources)
            provider = "ollama.chat" if sources else "deterministic"
            result = OrchestrationResult(
                request_id=request_id,
                conversation_id=conversation_id,
                route="local",
                reply=reply,
                provider=provider,
                memories_used=len(sources),
                sources=sources,
            )
            transition_request(request_id, "completed", route=result.route, provider=provider)
            record_audit(
                "request.routed",
                {"decision": result.route, "provider": provider, "memories_used": len(sources)},
                request_id,
                conversation_id,
            )
            return result.to_dict()

        cloud_requested = _cloud_requested(clean)
        try:
            suggested_route = "local" if len(clean.split()) <= 12 and not cloud_requested else await ollama_route(clean)
        except Exception:
            suggested_route = "cloud" if cloud_requested else "local"

        if cloud_requested or suggested_route == "cloud":
            if _is_private(clean):
                result = OrchestrationResult(
                    request_id=request_id,
                    conversation_id=conversation_id,
                    route="approval_required",
                    reason="This request may send personal or connected-account data to a cloud provider.",
                    memory_sent=False,
                    cloud_prompt=clean,
                )
                transition_request(request_id, "awaiting_approval", route=result.route)
                record_audit("request.routed", {"decision": result.route, "memory_sent": False}, request_id, conversation_id)
                return result.to_dict()

            provider = get_provider("openai")
            provider_name = provider.name if provider else "openai"
            result = OrchestrationResult(
                request_id=request_id,
                conversation_id=conversation_id,
                route="cloud_ready",
                provider=provider_name,
                reason="This request benefits from a cloud specialist.",
                memory_sent=False,
                cloud_prompt=clean,
            )
            transition_request(request_id, "cloud_ready", route=result.route, provider=provider_name)
            record_audit("request.routed", {"decision": result.route, "provider": provider_name}, request_id, conversation_id)
            return result.to_dict()

        transition_request(request_id, "local_processing", route="local", provider="ollama.chat")
        context = retrieve_context(clean, 8)
        reply = await ollama_chat(clean, context)
        result = OrchestrationResult(
            request_id=request_id,
            conversation_id=conversation_id,
            route="local",
            reply=reply,
            provider="ollama.chat",
            memories_used=len(context),
        )
        transition_request(request_id, "completed", route=result.route, provider=result.provider)
        record_audit(
            "request.routed",
            {"decision": result.route, "provider": result.provider, "memories_used": len(context)},
            request_id,
            conversation_id,
        )
        return result.to_dict()
    except Exception as exc:
        transition_request(request_id, "failed", error_type=type(exc).__name__)
        record_audit(
            "request.failed",
            {"error_type": type(exc).__name__},
            request_id,
            conversation_id,
        )
        raise

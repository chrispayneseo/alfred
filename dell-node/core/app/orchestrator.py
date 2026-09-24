"""Authoritative Alfred Core request orchestration.

Every first-party channel converges here. Models may classify or answer, but
routing, privacy, permissions, provider selection and audit remain deterministic
Core responsibilities.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Literal

from .candidate_extractor import capture as capture_memory_candidates
from .clients import ollama_chat, ollama_route
from .cloud_execution import execute_cloud_request
from .conversation_store import merge_history, recent_turns, record_turn
from .core import normalise_request
from .db import record_audit
from .lifecycle import begin_request, transition_request
from .memory_service import retrieve_context
from .privacy import cloud_requested, explicit_cloud, needs_connected_data
from .recall_store import recall_intent

Route = Literal[
    "local", "cloud", "cloud_ready", "cloud_failed",
    "approval_required", "connection_needed",
]


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
    model: str | None = None
    usage: dict | None = None
    web_search: bool | None = None
    approval: dict | None = None

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["decision"] = payload.pop("route")
        for key in ("sources", "cloud_prompt", "model", "usage", "web_search", "approval"):
            if payload.get(key) is None:
                payload.pop(key, None)
        return payload


def _capture_candidates_safely(message: str, request_id: str, conversation_id: str) -> int:
    """Candidate housekeeping must never make an otherwise valid request fail."""
    try:
        return len(capture_memory_candidates(
            message,
            request_id=request_id,
            conversation_id=conversation_id,
        ))
    except Exception as exc:
        record_audit(
            "memory.candidate_extraction_failed",
            {"error_type": type(exc).__name__},
            request_id,
            conversation_id,
        )
        return 0


async def orchestrate(
    *,
    channel: str,
    message: str,
    conversation_id: str | None = None,
    recall_answerer=None,
    history: list[dict] | None = None,
) -> dict:
    """Process a request through Alfred Core's deterministic decision boundary."""
    request = normalise_request(channel, message, conversation_id)
    request_id = request["request_id"]
    conversation_id = request["conversation_id"]
    clean = request["message"]

    begin_request(request)
    # Read context before adding the current turn so the current message is not
    # duplicated in the local model history.
    short_term_history = merge_history(recent_turns(conversation_id), history)
    record_turn(conversation_id, "user", clean, request_id=request_id)

    transition_request(request_id, "routing")
    record_audit(
        "request.received",
        {
            "channel": channel,
            "operation": "orchestrate",
            "short_term_turns": len(short_term_history),
        },
        request_id,
        conversation_id,
    )

    try:
        if needs_connected_data(clean):
            result = OrchestrationResult(
                request_id=request_id,
                conversation_id=conversation_id,
                route="connection_needed",
                reason="The requested connected account is not linked to Alfred Core yet.",
                reply="I can't check that connected account from the Dell yet. Its data has not been linked to the local gateway.",
            )
            record_turn(conversation_id, "assistant", result.reply or "", request_id=request_id)
            transition_request(request_id, "connection_needed", route=result.route)
            record_audit("request.routed", {"decision": result.route}, request_id, conversation_id)
            return result.to_dict()

        if recall_intent(clean) and not explicit_cloud(clean):
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
            record_turn(conversation_id, "assistant", reply, request_id=request_id)
            candidates = _capture_candidates_safely(clean, request_id, conversation_id)
            transition_request(request_id, "completed", route=result.route, provider=provider)
            record_audit(
                "request.routed",
                {
                    "decision": result.route,
                    "provider": provider,
                    "memories_used": len(sources),
                    "memory_candidates": candidates,
                },
                request_id,
                conversation_id,
            )
            return result.to_dict()

        wants_cloud = cloud_requested(clean)
        try:
            suggested_route = "local" if len(clean.split()) <= 12 and not wants_cloud else await ollama_route(clean)
        except Exception:
            suggested_route = "cloud" if wants_cloud else "local"

        if wants_cloud or suggested_route == "cloud":
            # Short-term conversation history is deliberately NOT supplied here.
            # Off-device execution receives only the current prompt unless a
            # future explicit policy/approval path says otherwise. Candidate
            # extraction is also deliberately skipped for cloud-routed prompts.
            cloud = await execute_cloud_request(request_id=request_id, prompt=clean)
            state = cloud.get("state")
            provider = cloud.get("provider")

            if state == "approval_required":
                result = OrchestrationResult(
                    request_id=request_id,
                    conversation_id=conversation_id,
                    route="approval_required",
                    provider=provider,
                    model=cloud.get("model"),
                    reason="This request may send personal data to a cloud provider.",
                    memory_sent=False,
                    cloud_prompt=clean,
                    approval=cloud.get("approval"),
                )
                transition_request(request_id, "awaiting_approval", route=result.route, provider=provider)
                record_audit(
                    "request.routed",
                    {"decision": result.route, "provider": provider, "memory_sent": False},
                    request_id,
                    conversation_id,
                )
                return result.to_dict()

            if state == "provider_unavailable":
                result = OrchestrationResult(
                    request_id=request_id,
                    conversation_id=conversation_id,
                    route="cloud_ready",
                    provider=provider,
                    model=cloud.get("model"),
                    reason=cloud.get("reason") or "This request benefits from a cloud specialist.",
                    memory_sent=False,
                    cloud_prompt=clean,
                )
                transition_request(request_id, "cloud_ready", route=result.route, provider=provider)
                record_audit(
                    "request.routed",
                    {"decision": result.route, "provider": provider, "configured": False},
                    request_id,
                    conversation_id,
                )
                return result.to_dict()

            if state == "completed":
                result = OrchestrationResult(
                    request_id=request_id,
                    conversation_id=conversation_id,
                    route="cloud",
                    reply=cloud.get("reply"),
                    provider=provider,
                    model=cloud.get("model"),
                    usage=cloud.get("usage"),
                    web_search=bool(cloud.get("web_search")),
                    reason="Handled by a Core-selected cloud specialist.",
                    memory_sent=False,
                )
                if isinstance(result.reply, str) and result.reply.strip():
                    record_turn(conversation_id, "assistant", result.reply, request_id=request_id)
                transition_request(request_id, "completed", route=result.route, provider=provider)
                record_audit(
                    "request.routed",
                    {"decision": result.route, "provider": provider, "memory_sent": False},
                    request_id,
                    conversation_id,
                )
                return result.to_dict()

            result = OrchestrationResult(
                request_id=request_id,
                conversation_id=conversation_id,
                route="cloud_failed",
                provider=provider,
                reason="The selected cloud specialist failed before returning a verified response.",
                memory_sent=False,
            )
            transition_request(request_id, "failed", route=result.route, provider=provider,
                               error_type=cloud.get("error_type") or "CloudProviderError")
            record_audit(
                "request.routed",
                {"decision": result.route, "provider": provider},
                request_id,
                conversation_id,
            )
            return result.to_dict()

        transition_request(request_id, "local_processing", route="local", provider="ollama.chat")
        context = retrieve_context(clean, 8)
        reply = await ollama_chat(clean, context, history=short_term_history)
        record_turn(conversation_id, "assistant", reply, request_id=request_id)
        candidates = _capture_candidates_safely(clean, request_id, conversation_id)
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
            {
                "decision": result.route,
                "provider": result.provider,
                "memories_used": len(context),
                "memory_candidates": candidates,
            },
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

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
from .execution import execute_tool
from .lifecycle import begin_request, transition_request
from .memory_service import retrieve_context
from .mutation_tool_planner import plan_mutation_tool
from .privacy import cloud_requested, explicit_cloud, needs_connected_data
from .read_tool_planner import plan_read_tool, render_result as render_tool_result, sources_for_result
from .recall_store import recall_intent

Route = Literal[
    "local", "tool", "tool_failed", "denied", "cloud", "cloud_ready", "cloud_failed",
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
    tool_action: str | None = None
    integration: str | None = None

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["decision"] = payload.pop("route")
        for key in (
            "sources", "cloud_prompt", "model", "usage", "web_search", "approval",
            "tool_action", "integration",
        ):
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
    short_term_history = merge_history(recent_turns(conversation_id), history)
    record_turn(conversation_id, "user", clean, request_id=request_id)

    transition_request(request_id, "routing")
    record_audit(
        "request.received",
        {"channel": channel, "operation": "orchestrate", "short_term_turns": len(short_term_history)},
        request_id,
        conversation_id,
    )

    try:
        # Mutations are planned before reads, but only exact deterministic forms
        # can produce a plan. The first executor pass is deliberately unconfirmed:
        # it may create an exact-scope approval, but cannot perform the mutation.
        mutation_plan = plan_mutation_tool(clean)
        if mutation_plan is not None:
            provider = f"integration:{mutation_plan.integration}"
            transition_request(request_id, "tool_planning", route="approval_required", provider=provider)
            execution = await execute_tool(
                request_id=request_id,
                action=mutation_plan.action,
                arguments=mutation_plan.arguments,
            )
            state = execution.get("state")
            if state == "approval_required":
                approval = execution.get("approval") if isinstance(execution.get("approval"), dict) else None
                reply = "I can do that, but this change needs your confirmation first."
                record_turn(conversation_id, "assistant", reply, request_id=request_id)
                result = OrchestrationResult(
                    request_id=request_id,
                    conversation_id=conversation_id,
                    route="approval_required",
                    reply=reply,
                    provider=provider,
                    reason=mutation_plan.reason,
                    memory_sent=False,
                    approval=approval,
                    tool_action=mutation_plan.action,
                    integration=mutation_plan.integration,
                )
                transition_request(request_id, "awaiting_approval", route=result.route, provider=provider)
                record_audit(
                    "request.tool_approval_required",
                    {"action": mutation_plan.action, "integration": mutation_plan.integration,
                     "approval_id": approval.get("id") if approval else None},
                    request_id,
                    conversation_id,
                )
                return result.to_dict()

            error = execution.get("error") or "The requested integration change was denied."
            reply = error
            record_turn(conversation_id, "assistant", reply, request_id=request_id)
            result = OrchestrationResult(
                request_id=request_id,
                conversation_id=conversation_id,
                route="denied",
                reply=reply,
                provider=provider,
                reason=error,
                memory_sent=False,
                tool_action=mutation_plan.action,
                integration=mutation_plan.integration,
            )
            transition_request(request_id, "denied", route="denied", provider=provider)
            record_audit(
                "request.tool_denied",
                {"action": mutation_plan.action, "integration": mutation_plan.integration},
                request_id,
                conversation_id,
            )
            return result.to_dict()

        # Phase 3 read planner may only emit registered read+auto tools; the
        # executor still performs integration availability, policy, execution
        # and verification checks.
        read_plan = plan_read_tool(clean)
        if read_plan is not None:
            transition_request(
                request_id, "tool_planning", route="tool",
                provider=f"integration:{read_plan.integration}",
            )
            execution = await execute_tool(
                request_id=request_id,
                action=read_plan.action,
                arguments=read_plan.arguments,
            )
            state = execution.get("state")
            if state == "completed" and (execution.get("verification") or {}).get("ok") is True:
                tool_payload = execution.get("result") if isinstance(execution.get("result"), dict) else {}
                reply = render_tool_result(read_plan.action, tool_payload)
                sources = sources_for_result(read_plan.action, tool_payload)
                provider = f"integration:{read_plan.integration}"
                record_turn(conversation_id, "assistant", reply, request_id=request_id)
                result = OrchestrationResult(
                    request_id=request_id, conversation_id=conversation_id, route="tool",
                    reply=reply, provider=provider, reason=read_plan.reason, sources=sources,
                    memory_sent=False, tool_action=read_plan.action,
                    integration=read_plan.integration,
                )
                transition_request(request_id, "completed", route=result.route, provider=provider)
                record_audit(
                    "request.tool_executed",
                    {"action": read_plan.action, "integration": read_plan.integration,
                     "source_count": len(sources)},
                    request_id,
                    conversation_id,
                )
                return result.to_dict()

            error = execution.get("error") or "The selected integration read failed verification."
            if state == "denied" and "not configured" in error.casefold():
                route: Route = "connection_needed"
                reply = error
                transition_request(request_id, "connection_needed", route=route)
            else:
                route = "tool_failed"
                reply = "The integration could not complete that read safely."
                transition_request(request_id, "failed", route=route, error_type="IntegrationReadError")
            result = OrchestrationResult(
                request_id=request_id, conversation_id=conversation_id, route=route,
                reply=reply, provider=f"integration:{read_plan.integration}", reason=error,
                memory_sent=False, tool_action=read_plan.action, integration=read_plan.integration,
            )
            record_turn(conversation_id, "assistant", reply, request_id=request_id)
            record_audit(
                "request.tool_unavailable" if route == "connection_needed" else "request.tool_failed",
                {"action": read_plan.action, "integration": read_plan.integration},
                request_id,
                conversation_id,
            )
            return result.to_dict()

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
                request_id=request_id, conversation_id=conversation_id, route="local",
                reply=reply, provider=provider, memories_used=len(sources), sources=sources,
            )
            record_turn(conversation_id, "assistant", reply, request_id=request_id)
            candidates = _capture_candidates_safely(clean, request_id, conversation_id)
            transition_request(request_id, "completed", route=result.route, provider=provider)
            record_audit(
                "request.routed",
                {"decision": result.route, "provider": provider, "memories_used": len(sources),
                 "memory_candidates": candidates},
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
            cloud = await execute_cloud_request(request_id=request_id, prompt=clean)
            state = cloud.get("state")
            provider = cloud.get("provider")

            if state == "approval_required":
                result = OrchestrationResult(
                    request_id=request_id, conversation_id=conversation_id,
                    route="approval_required", provider=provider, model=cloud.get("model"),
                    reason="This request may send personal data to a cloud provider.",
                    memory_sent=False, cloud_prompt=clean, approval=cloud.get("approval"),
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
                    request_id=request_id, conversation_id=conversation_id,
                    route="cloud_ready", provider=provider, model=cloud.get("model"),
                    reason=cloud.get("reason") or "This request benefits from a cloud specialist.",
                    memory_sent=False, cloud_prompt=clean,
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
                    request_id=request_id, conversation_id=conversation_id, route="cloud",
                    reply=cloud.get("reply"), provider=provider, model=cloud.get("model"),
                    usage=cloud.get("usage"), web_search=bool(cloud.get("web_search")),
                    reason="Handled by a Core-selected cloud specialist.", memory_sent=False,
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
                request_id=request_id, conversation_id=conversation_id, route="cloud_failed",
                provider=provider,
                reason="The selected cloud specialist failed before returning a verified response.",
                memory_sent=False,
            )
            transition_request(
                request_id, "failed", route=result.route, provider=provider,
                error_type=cloud.get("error_type") or "CloudProviderError",
            )
            record_audit(
                "request.routed", {"decision": result.route, "provider": provider},
                request_id, conversation_id,
            )
            return result.to_dict()

        transition_request(request_id, "local_processing", route="local", provider="ollama.chat")
        context = retrieve_context(clean, 8)
        reply = await ollama_chat(clean, context, history=short_term_history)
        record_turn(conversation_id, "assistant", reply, request_id=request_id)
        candidates = _capture_candidates_safely(clean, request_id, conversation_id)
        result = OrchestrationResult(
            request_id=request_id, conversation_id=conversation_id, route="local",
            reply=reply, provider="ollama.chat", memories_used=len(context),
        )
        transition_request(request_id, "completed", route=result.route, provider=result.provider)
        record_audit(
            "request.routed",
            {"decision": result.route, "provider": result.provider,
             "memories_used": len(context), "memory_candidates": candidates},
            request_id,
            conversation_id,
        )
        return result.to_dict()
    except Exception as exc:
        transition_request(request_id, "failed", error_type=type(exc).__name__)
        record_audit(
            "request.failed", {"error_type": type(exc).__name__},
            request_id, conversation_id,
        )
        raise

from __future__ import annotations

from contextlib import asynccontextmanager
import asyncio
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import settings
from .db import (
    initialise, record_audit, create_plan, list_plans,
    create_approval, resolve_approval, record_event,
)
from .clients import ollama_chat, ollama_recall
from .cloud_execution import execute_cloud_request
from .cloud_providers import provider_health
from . import inbox_api, memory_service
from .recall_store import recall_intent, requested_list
from .core import tool_registry, event_decision
from .orchestrator import orchestrate
from .providers import provider_registry
from .execution import execute_plan, execute_tool, initialise_execution_store, list_executions
from .legacy_actions import execute_legacy_action
from .recovery import recover_interrupted_work, recovery_summary, retry_execution
from .lifecycle import (
    get_request as get_request_state,
    initialise_request_store,
    lifecycle_summary,
    list_requests,
    request_timeline,
    transition_request,
)


def authorised(x_alfred_key: str = Header(default=""), tailscale_user_login: str = Header(default="")):
    key_ok = bool(settings.api_key) and x_alfred_key == settings.api_key
    tailnet_ok = bool(settings.tailscale_user) and tailscale_user_login == settings.tailscale_user
    if not (key_ok or tailnet_ok):
        raise HTTPException(status_code=401, detail="Alfred authentication required")


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialise()
    initialise_execution_store()
    initialise_request_store()
    recover_interrupted_work()
    inbox_api.initialise()
    triage_task = asyncio.create_task(inbox_api.triage_loop())
    reminder_task = asyncio.create_task(inbox_api.reminder_loop())
    try:
        yield
    finally:
        triage_task.cancel()
        reminder_task.cancel()
        try:
            await asyncio.gather(triage_task, reminder_task)
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Alfred Local Intelligence Node", version="0.8.0", lifespan=lifespan)
app.include_router(inbox_api.router, dependencies=[Depends(authorised)])
web_origins = [origin.strip() for origin in settings.web_origin.split(",") if origin.strip()]
if web_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=web_origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )


class Memory(BaseModel):
    kind: str = Field(min_length=1, max_length=64)
    content: str = Field(min_length=1, max_length=4000)
    source: str = Field(default="api", max_length=64)
    confirmed: bool = False


class MemoryCorrection(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    confirmed: bool = False


class Chat(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    fast: bool = False


class GatewayRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=12)


class CoreRequest(BaseModel):
    channel: str = Field(pattern="^(web|whatsapp|voice|email|api|webhook)$")
    message: str = Field(min_length=1, max_length=4000)
    conversation_id: Optional[str] = Field(default=None, max_length=160)


class PlanRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=64)
    goal: str = Field(min_length=1, max_length=1000)
    steps: list[dict] = Field(min_length=1, max_length=20)


class ToolExecutionRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=64)
    action: str = Field(min_length=1, max_length=120)
    arguments: dict = Field(default_factory=dict)


class CloudExecutionRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1, max_length=12000)
    provider: Optional[str] = Field(default=None, pattern="^(openai|claude)$")
    confirmed: bool = False


class ApprovalRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=64)
    action: str = Field(min_length=1, max_length=120)
    summary: str = Field(min_length=1, max_length=1000)
    risk_level: str = Field(pattern="^(safe_write|reversible|external|high_impact)$")
    plan_id: Optional[str] = Field(default=None, max_length=64)


class ApprovalResolution(BaseModel):
    approved: bool


class CoreEvent(BaseModel):
    event_type: str = Field(min_length=3, max_length=120)
    source: str = Field(min_length=1, max_length=120)
    payload: dict = Field(default_factory=dict)


class DeviceAction(BaseModel):
    service: str = Field(pattern=r"^[a-z_]+\.[a-z_]+$")
    entity_id: str = Field(pattern=r"^[a-z_]+\.[a-zA-Z0-9_]+$")
    confirmed: bool = False


def _legacy_conflict(result: dict, proposal: dict | None = None):
    detail = {"policy": result.get("policy", {})}
    if proposal is not None:
        detail["proposal"] = proposal
    raise HTTPException(status_code=409, detail=detail)


def _legacy_failure(result: dict, *, not_found: bool = False):
    error = result.get("error") or "Core execution failed"
    if not_found and error == "Memory not found":
        raise HTTPException(404, "Memory not found")
    raise HTTPException(status_code=503, detail=error)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "models": {"chat": settings.chat_model, "router": settings.router_model},
        "core": {
            "tool_count": len(tool_registry()),
            "provider_count": len(provider_registry()),
            "orchestrator": "authoritative",
            "executor": "policy_gated",
            "verification": "enabled",
            "request_lifecycle": "durable",
            "memory_service": "unified",
            "legacy_mutations": "executor_routed",
            "recovery_policy": "fail_closed",
            "provider_runtime": "policy_gated",
            "safe_mode": False,
        },
    }


@app.post("/v1/memories", dependencies=[Depends(authorised)])
async def create_memory(memory: Memory):
    result = await execute_legacy_action(
        action="memory.write",
        arguments={"kind": memory.kind, "content": memory.content, "source": memory.source},
        confirmed=memory.confirmed,
    )
    if result.get("state") == "approval_required":
        _legacy_conflict(result)
    if result.get("state") != "completed":
        _legacy_failure(result)
    return {"id": result["result"]["memory_id"]}


@app.get("/v1/memories", dependencies=[Depends(authorised)])
async def get_memories(q: str, limit: int = 8):
    return {"items": memory_service.search_memories(q, limit)}


@app.delete("/v1/memories/{memory_id}", dependencies=[Depends(authorised)])
async def delete_memory(memory_id: int):
    result = await execute_legacy_action(
        action="memory.delete",
        arguments={"memory_id": memory_id},
        confirmed=True,
    )
    if result.get("state") != "completed":
        _legacy_failure(result, not_found=True)
    return {"deleted": True}


@app.get("/v1/memories/{memory_id}", dependencies=[Depends(authorised)])
async def read_memory(memory_id: int):
    item = memory_service.get_memory(memory_id)
    if item is None:
        raise HTTPException(404, "Memory not found")
    return item


@app.post("/v1/memories/{memory_id}/edit", dependencies=[Depends(authorised)])
async def edit_memory(memory_id: int, correction: MemoryCorrection):
    result = await execute_legacy_action(
        action="memory.correct",
        arguments={"memory_id": memory_id, "content": correction.content},
        confirmed=correction.confirmed,
    )
    if result.get("state") == "approval_required":
        _legacy_conflict(result)
    if result.get("state") != "completed":
        _legacy_failure(result, not_found=True)
    return {"updated": True}


@app.get("/v1/recall", dependencies=[Depends(authorised)])
async def search_recall(q: str, limit: int = 6):
    return {"sources": memory_service.retrieve_context(q, limit)}


async def answer_from_recall(message: str, sources: list[dict]) -> str:
    if requested_list(message):
        if not sources:
            return "I couldn't find any matching open items saved on the Dell."
        labels = [f"{item['title']}{' — ' + item['due'] if item['due'] else ''}" for item in sources]
        return "Here are the saved items I found: " + "; ".join(labels) + "."
    if not sources:
        return "I couldn't find anything matching that in Alfred's local memory, tasks or reminders."
    try:
        return await ollama_recall(message, sources)
    except Exception:
        snippets = [item["content"][:250].replace("\n", " ") for item in sources[:3]]
        return "I found this saved on the Dell: " + "; ".join(snippets) + ". Check the linked sources for the full details."


@app.post("/v1/chat", dependencies=[Depends(authorised)])
async def chat(request: Chat):
    context = memory_service.retrieve_context(request.message, 8)
    if recall_intent(request.message):
        return {
            "reply": await answer_from_recall(request.message, context),
            "memories_used": len(context),
            "sources": context,
        }
    return {
        "reply": await ollama_chat(request.message, context, request.fast),
        "memories_used": len(context),
    }


@app.post("/v1/gateway", dependencies=[Depends(authorised)])
async def gateway(request: GatewayRequest):
    result = await orchestrate(
        channel="web", message=request.message, recall_answerer=answer_from_recall,
    )
    if result.get("decision") == "local":
        if result.get("provider") == "ollama.chat":
            result["model"] = settings.chat_model
        elif result.get("provider") == "deterministic":
            result["model"] = "deterministic"
    return result


@app.post("/v1/home-assistant/service", dependencies=[Depends(authorised)])
async def device_action(action: DeviceAction):
    arguments = {"service": action.service, "entity_id": action.entity_id}
    result = await execute_legacy_action(
        action="home_assistant.service",
        arguments=arguments,
        confirmed=action.confirmed,
    )
    if result.get("state") == "approval_required":
        _legacy_conflict(result, proposal=arguments)
    if result.get("state") != "completed":
        _legacy_failure(result)
    return result["result"]


@app.post("/v1/requests", dependencies=[Depends(authorised)])
async def receive_request(request: CoreRequest):
    return await orchestrate(
        channel=request.channel,
        message=request.message,
        conversation_id=request.conversation_id,
        recall_answerer=answer_from_recall,
    )


@app.get("/v1/core/status", dependencies=[Depends(authorised)])
async def core_status():
    return {
        "status": "ok",
        "lifecycle": lifecycle_summary(),
        "tools": {"registered": len(tool_registry())},
        "providers": provider_registry(),
        "memory": {"service": "unified"},
        "compatibility": {"legacy_mutations": "executor_routed"},
        "recovery": recovery_summary(20),
    }


@app.get("/v1/core/requests", dependencies=[Depends(authorised)])
async def get_core_requests(state: Optional[str] = None, limit: int = 50):
    return {"items": list_requests(limit=limit, state=state)}


@app.get("/v1/core/requests/{request_id}", dependencies=[Depends(authorised)])
async def get_core_request(request_id: str):
    item = get_request_state(request_id)
    if item is None:
        raise HTTPException(404, "Request not found")
    return {"request": item, "timeline": request_timeline(request_id)}


@app.get("/v1/core/tools", dependencies=[Depends(authorised)])
async def get_tools():
    return {"tools": tool_registry()}


@app.get("/v1/core/providers", dependencies=[Depends(authorised)])
async def get_providers():
    return {"providers": provider_registry()}


@app.get("/v1/core/providers/health", dependencies=[Depends(authorised)])
async def get_provider_health():
    return {"providers": await provider_health()}


@app.post("/v1/core/cloud/execute", dependencies=[Depends(authorised)])
async def execute_cloud(request: CloudExecutionRequest):
    if get_request_state(request.request_id) is None:
        raise HTTPException(404, "Request not found")
    result = await execute_cloud_request(
        request_id=request.request_id,
        prompt=request.prompt,
        provider=request.provider,
        confirmed=request.confirmed,
    )
    state = result.get("state")
    provider = result.get("provider")
    if state == "approval_required":
        transition_request(request.request_id, "awaiting_approval", route="approval_required", provider=provider)
    elif state == "provider_unavailable":
        transition_request(request.request_id, "cloud_ready", route="cloud_ready", provider=provider)
    elif state == "completed":
        transition_request(request.request_id, "completed", route="cloud", provider=provider)
    elif state == "failed":
        transition_request(
            request.request_id,
            "failed",
            route="cloud_failed",
            provider=provider,
            error_type=result.get("error_type") or "CloudProviderError",
        )
    return result


@app.post("/v1/core/execute", dependencies=[Depends(authorised)])
async def execute_registered_tool(request: ToolExecutionRequest):
    return await execute_tool(
        request_id=request.request_id, action=request.action, arguments=request.arguments,
    )


@app.get("/v1/core/executions", dependencies=[Depends(authorised)])
async def get_executions(request_id: Optional[str] = None, limit: int = 50):
    return {"items": list_executions(request_id=request_id, limit=limit)}


@app.get("/v1/core/recovery", dependencies=[Depends(authorised)])
async def get_recovery(limit: int = 50):
    return recovery_summary(limit)


@app.post("/v1/core/executions/{execution_id}/retry", dependencies=[Depends(authorised)])
async def retry_core_execution(execution_id: str):
    result = await retry_execution(execution_id)
    if result.get("state") == "not_found":
        raise HTTPException(404, "Execution not found")
    if result.get("recovery") == "reconcile_required":
        raise HTTPException(status_code=409, detail=result)
    return result


@app.post("/v1/core/plans", dependencies=[Depends(authorised)])
async def create_task_plan(request: PlanRequest):
    plan = create_plan(request.request_id, request.goal, request.steps)
    record_audit("plan.created", {"plan_id": plan["id"], "step_count": len(request.steps)}, request.request_id)
    return plan


@app.get("/v1/core/plans", dependencies=[Depends(authorised)])
async def get_plans(limit: int = 50):
    return {"items": list_plans(max(1, min(limit, 100)))}


@app.post("/v1/core/plans/{plan_id}/execute", dependencies=[Depends(authorised)])
async def execute_task_plan(plan_id: str):
    result = await execute_plan(plan_id)
    if result["state"] == "not_found":
        raise HTTPException(404, "Plan not found")
    return result


@app.post("/v1/core/approvals", dependencies=[Depends(authorised)])
async def request_approval(request: ApprovalRequest):
    approval = create_approval(
        request.request_id, request.plan_id, request.action,
        request.summary, request.risk_level,
    )
    record_audit("approval.requested", {"approval_id": approval["id"], "action": request.action}, request.request_id)
    return approval


@app.post("/v1/core/approvals/{approval_id}", dependencies=[Depends(authorised)])
async def decide_approval(approval_id: str, resolution: ApprovalResolution):
    if not resolve_approval(approval_id, resolution.approved):
        raise HTTPException(404, "Pending approval not found")
    record_audit("approval.resolved", {"approval_id": approval_id, "approved": resolution.approved})
    return {"id": approval_id, "state": "approved" if resolution.approved else "rejected"}


@app.post("/v1/events", dependencies=[Depends(authorised)])
async def receive_event(event: CoreEvent):
    decision = event_decision(event.event_type)
    stored = record_event(event.event_type, event.source, decision, event.payload)
    record_audit(
        "event.received",
        {"event_id": stored["id"], "decision": decision, "event_type": event.event_type},
    )
    return stored

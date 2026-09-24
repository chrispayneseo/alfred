from contextlib import asynccontextmanager
import asyncio
import re
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from .config import settings
from .db import correct_memory, forget, get_memory, initialise, list_memories, recall, remember
from .clients import home_assistant, ollama_chat, ollama_recall, ollama_route
from . import inbox_api
from .recall_store import recall_intent, requested_list, search as search_local


def authorised(x_alfred_key: str = Header(default=""), tailscale_user_login: str = Header(default="")):
    key_ok = bool(settings.api_key) and x_alfred_key == settings.api_key
    tailnet_ok = bool(settings.tailscale_user) and tailscale_user_login == settings.tailscale_user
    if not (key_ok or tailnet_ok):
        raise HTTPException(status_code=401, detail="Alfred authentication required")


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialise()
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


app = FastAPI(title="Alfred Local Intelligence Node", version="0.1.0", lifespan=lifespan)
app.include_router(inbox_api.router, dependencies=[Depends(authorised)])
web_origins = [origin.strip() for origin in settings.web_origin.split(",") if origin.strip()]
if web_origins:
    app.add_middleware(CORSMiddleware, allow_origins=web_origins,
                       allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type"],
                       allow_credentials=False)


class Memory(BaseModel):
    kind: str = Field(max_length=64)
    content: str = Field(min_length=1, max_length=4000)
    source: str = Field(default="api", max_length=64)


class MemoryCorrection(BaseModel):
    content: str = Field(min_length=1, max_length=4000)


class Chat(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    fast: bool = False


class GatewayRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=12)


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


class DeviceAction(BaseModel):
    service: str = Field(pattern=r"^[a-z_]+\.[a-z_]+$")
    entity_id: str = Field(pattern=r"^[a-z_]+\.[a-zA-Z0-9_]+$")


@app.get("/health")
async def health():
    return {"status": "ok", "models": {"chat": settings.chat_model, "router": settings.router_model}}


@app.post("/v1/memories", dependencies=[Depends(authorised)])
async def create_memory(memory: Memory):
    return {"id": remember(memory.kind, memory.content, memory.source)}


@app.get("/v1/memories", dependencies=[Depends(authorised)])
async def get_memories(q: str, limit: int = 8):
    size = max(1, min(limit, 50))
    return {"items": recall(q, size) if q.strip() else list_memories(size)}


@app.delete("/v1/memories/{memory_id}", dependencies=[Depends(authorised)])
async def delete_memory(memory_id: int):
    if not forget(memory_id):
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"deleted": True}


@app.get("/v1/memories/{memory_id}", dependencies=[Depends(authorised)])
async def read_memory(memory_id: int):
    item = get_memory(memory_id)
    if item is None:
        raise HTTPException(404, "Memory not found")
    return item


@app.post("/v1/memories/{memory_id}/edit", dependencies=[Depends(authorised)])
async def edit_memory(memory_id: int, correction: MemoryCorrection):
    if not correct_memory(memory_id, correction.content.strip()):
        raise HTTPException(404, "Memory not found")
    return {"updated": True}


@app.get("/v1/recall", dependencies=[Depends(authorised)])
async def search_recall(q: str, limit: int = 6):
    return {"sources": search_local(q[:500], max(1, min(limit, 10)))}


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
    if recall_intent(request.message):
        sources = search_local(request.message)
        return {"reply": await answer_from_recall(request.message, sources), "memories_used": len(sources), "sources": sources}
    memories = recall(request.message)
    return {"reply": await ollama_chat(request.message, memories, request.fast), "memories_used": len(memories)}


@app.post("/v1/gateway", dependencies=[Depends(authorised)])
async def gateway(request: GatewayRequest):
    """Local triage. Never transmits content to a cloud provider."""
    message = request.message.strip()
    lowered = message.lower()
    private = (any(term in lowered for term in PRIVATE_TERMS)
               or bool(re.search(r"\b(my|mine|me|i|we|our)\b", lowered))
               or bool(re.search(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b", message)))
    cloud_requested = any(term in lowered for term in CLOUD_TERMS)
    if any(term in lowered for term in CONNECTED_TERMS):
        return {"decision": "connection_needed",
                "reply": "I can't check that connected account from the Dell yet. Its data has not been linked to the local gateway."}
    # A saved-item question stays local unless the user explicitly asks for web/cloud work.
    explicit_cloud = any(term in lowered for term in ("research", "browse", "search the web", "use chatgpt", "use claude", "send to cloud"))
    if recall_intent(message) and not explicit_cloud:
        sources = search_local(message)
        reply = await answer_from_recall(message, sources)
        return {"decision": "local", "reply": reply,
                "model": settings.chat_model if sources and not requested_list(message) else "deterministic",
                "memories_used": len(sources), "sources": sources}
    try:
        model_route = "local" if len(message.split()) <= 12 and not cloud_requested else await ollama_route(message)
    except Exception:
        model_route = "cloud" if cloud_requested else "local"
    if private and (cloud_requested or model_route == "cloud"):
        return {
            "decision": "approval_required",
            "reason": "This request may use personal or connected account data.",
            "cloud_prompt": message,
            "memory_sent": False,
        }
    if cloud_requested or model_route == "cloud":
        return {
            "decision": "cloud_ready",
            "reason": "This request benefits from a cloud specialist.",
            "cloud_prompt": message,
            "memory_sent": False,
        }
    memories = recall(message)
    reply = await ollama_chat(message, memories)
    return {"decision": "local", "reply": reply, "model": settings.chat_model,
            "memories_used": len(memories)}


@app.post("/v1/home-assistant/service", dependencies=[Depends(authorised)])
async def device_action(action: DeviceAction):
    # This explicit endpoint is intentionally confirmation-friendly: callers choose the exact service/entity.
    try:
        return await home_assistant(action.service, action.entity_id)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error))

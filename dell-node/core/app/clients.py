import httpx
import json
from .config import settings


async def ollama_chat(message: str, context: list[dict], fast: bool = False) -> str:
    model = settings.router_model if fast else settings.chat_model
    prompt = ("You are Alfred, a concise household assistant. /no_think "
              "Return one JSON object with a single key named reply. "
              "The reply must contain only your final answer, never planning or reasoning. ")
    if context:
        prompt += "Relevant saved memory: " + "; ".join(item["content"] for item in context) + "\n"
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(f"{settings.ollama_url}/api/chat", json={
            "model": model, "stream": False, "think": False, "format": "json",
            "messages": [{"role": "system", "content": prompt},
                         {"role": "user", "content": f"{message}\n/no_think"}],
            "options": {"num_ctx": 2048, "num_predict": 256, "temperature": 0.2},
        })
        response.raise_for_status()
        payload = json.loads(response.json()["message"].get("content", "{}"))
        content = payload.get("reply", "")
        if not isinstance(content, str):
            content = ""
        content = content.strip()
        if not content:
            raise RuntimeError(f"{model} returned an empty answer")
        return content


async def ollama_route(message: str) -> str:
    """Small local model suggests local or cloud; the gateway applies hard privacy rules."""
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.post(f"{settings.ollama_url}/api/chat", json={
            "model": settings.router_model, "stream": False, "think": False,
            "format": "json",
            "messages": [
                {"role": "system", "content": (
                    "Classify the user's request. Return JSON with one key, route, whose value is "
                    "local or cloud. Choose cloud for current web facts, substantial coding, "
                    "complex research, or long-form writing. Otherwise choose local. "
                    "Do not answer the request."
                )},
                {"role": "user", "content": message},
            ],
            "options": {"num_ctx": 1024, "num_predict": 40, "temperature": 0},
        })
        response.raise_for_status()
        value = json.loads(response.json()["message"]["content"])
        return "cloud" if value.get("route") == "cloud" else "local"


async def home_assistant(service: str, entity_id: str) -> dict:
    if not settings.ha_url or not settings.ha_token:
        raise RuntimeError("Home Assistant is not configured")
    domain, action = service.split(".", 1)
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(f"{settings.ha_url}/api/services/{domain}/{action}",
            headers={"Authorization": f"Bearer {settings.ha_token}"}, json={"entity_id": entity_id})
        response.raise_for_status()
        return {"ok": True, "service": service, "entity_id": entity_id}

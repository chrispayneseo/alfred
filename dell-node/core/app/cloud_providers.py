"""Cloud specialist adapters owned by Alfred Core.

Prompts enter this module only after Core has made the routing/privacy decision.
Adapters never receive memory implicitly and never expose credentials in results.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from .config import settings


SYSTEM_PROMPT = (
    "You are Alfred, a concise personal-assistant specialist. Answer the user's request "
    "directly. Do not claim to have accessed local memories, accounts, devices, or tools "
    "unless that information is explicitly supplied in the request."
)


class CloudProviderError(RuntimeError):
    def __init__(self, provider: str, code: str, status_code: int | None = None):
        super().__init__(f"{provider} provider error: {code}")
        self.provider = provider
        self.code = code
        self.status_code = status_code


def _extract_openai_text(payload: dict[str, Any]) -> str:
    chunks: list[str] = []
    for item in payload.get("output", []):
        if not isinstance(item, dict):
            continue
        for block in item.get("content", []):
            if isinstance(block, dict) and block.get("type") == "output_text":
                text = block.get("text")
                if isinstance(text, str):
                    chunks.append(text)
    if not chunks and isinstance(payload.get("output_text"), str):
        chunks.append(payload["output_text"])
    text = "\n".join(part.strip() for part in chunks if part.strip()).strip()
    if not text:
        raise CloudProviderError("openai", "empty_response")
    return text


def _extract_anthropic_text(payload: dict[str, Any]) -> str:
    chunks = [
        block.get("text", "").strip()
        for block in payload.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    ]
    text = "\n".join(part for part in chunks if part).strip()
    if not text:
        raise CloudProviderError("claude", "empty_response")
    return text


async def openai_complete(
    prompt: str,
    *,
    max_output_tokens: int = 1024,
    web_search: bool = False,
) -> dict:
    if not settings.openai_api_key:
        raise CloudProviderError("openai", "not_configured")
    body: dict[str, Any] = {
        "model": settings.openai_model,
        "instructions": SYSTEM_PROMPT,
        "input": prompt,
        "max_output_tokens": max(64, min(max_output_tokens, 4096)),
    }
    if web_search:
        body["tools"] = [{"type": "web_search"}]
    async with httpx.AsyncClient(timeout=settings.cloud_timeout_seconds) as client:
        response = await client.post(
            "https://api.openai.com/v1/responses",
            headers={
                "Authorization": f"Bearer {settings.openai_api_key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
    if response.status_code >= 400:
        raise CloudProviderError("openai", "http_error", response.status_code)
    payload = response.json()
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    return {
        "provider": "openai",
        "model": payload.get("model") or settings.openai_model,
        "reply": _extract_openai_text(payload),
        "web_search": web_search,
        "usage": {
            "input_tokens": int(usage.get("input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
        },
    }


async def claude_complete(prompt: str, *, max_output_tokens: int = 1024) -> dict:
    if not settings.anthropic_api_key:
        raise CloudProviderError("claude", "not_configured")
    async with httpx.AsyncClient(timeout=settings.cloud_timeout_seconds) as client:
        response = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.anthropic_api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": settings.anthropic_model,
                "max_tokens": max(64, min(max_output_tokens, 4096)),
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
    if response.status_code >= 400:
        raise CloudProviderError("claude", "http_error", response.status_code)
    payload = response.json()
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    return {
        "provider": "claude",
        "model": payload.get("model") or settings.anthropic_model,
        "reply": _extract_anthropic_text(payload),
        "web_search": False,
        "usage": {
            "input_tokens": int(usage.get("input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
        },
    }


async def cloud_complete(
    provider: str,
    prompt: str,
    *,
    max_output_tokens: int = 1024,
    web_search: bool = False,
) -> dict:
    clean = prompt.strip()
    if not clean:
        raise ValueError("Prompt is required")
    if provider == "openai":
        return await openai_complete(
            clean,
            max_output_tokens=max_output_tokens,
            web_search=web_search,
        )
    if provider == "claude":
        return await claude_complete(clean, max_output_tokens=max_output_tokens)
    raise CloudProviderError(provider, "unknown_provider")


async def _probe_ollama(name: str, model: str) -> dict:
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(f"{settings.ollama_url}/api/tags")
        response.raise_for_status()
        models = {
            item.get("name")
            for item in response.json().get("models", [])
            if isinstance(item, dict)
        }
        available = model in models
        return {
            "name": name,
            "configured": True,
            "reachable": True,
            "model_available": available,
            "state": "ready" if available else "model_missing",
            "latency_ms": round((time.monotonic() - started) * 1000),
        }
    except Exception:
        return {
            "name": name,
            "configured": True,
            "reachable": False,
            "model_available": False,
            "state": "unreachable",
            "latency_ms": round((time.monotonic() - started) * 1000),
        }


async def _probe_openai() -> dict:
    if not settings.openai_api_key:
        return {"name": "openai", "configured": False, "reachable": False, "state": "disabled"}
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"https://api.openai.com/v1/models/{settings.openai_model}",
                headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            )
        state = "ready" if response.status_code == 200 else "error"
        return {
            "name": "openai",
            "configured": True,
            "reachable": response.status_code < 500,
            "model_available": response.status_code == 200,
            "state": state,
            "status_code": response.status_code,
            "latency_ms": round((time.monotonic() - started) * 1000),
        }
    except Exception:
        return {
            "name": "openai", "configured": True, "reachable": False,
            "model_available": False, "state": "unreachable",
            "latency_ms": round((time.monotonic() - started) * 1000),
        }


async def _probe_claude() -> dict:
    if not settings.anthropic_api_key:
        return {"name": "claude", "configured": False, "reachable": False, "state": "disabled"}
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"https://api.anthropic.com/v1/models/{settings.anthropic_model}",
                headers={
                    "x-api-key": settings.anthropic_api_key,
                    "anthropic-version": "2023-06-01",
                },
            )
        state = "ready" if response.status_code == 200 else "error"
        return {
            "name": "claude",
            "configured": True,
            "reachable": response.status_code < 500,
            "model_available": response.status_code == 200,
            "state": state,
            "status_code": response.status_code,
            "latency_ms": round((time.monotonic() - started) * 1000),
        }
    except Exception:
        return {
            "name": "claude", "configured": True, "reachable": False,
            "model_available": False, "state": "unreachable",
            "latency_ms": round((time.monotonic() - started) * 1000),
        }


async def provider_health() -> list[dict]:
    """Probe provider connectivity without sending user prompts or memory."""
    import asyncio

    return list(await asyncio.gather(
        _probe_ollama("ollama.chat", settings.chat_model),
        _probe_ollama("ollama.router", settings.router_model),
        _probe_openai(),
        _probe_claude(),
    ))

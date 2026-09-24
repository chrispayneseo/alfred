"""Provider metadata owned by Alfred Core.

The registry is intentionally declarative: models may suggest work, but the Core
remains responsible for deciding whether a provider may receive a request.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .config import settings


@dataclass(frozen=True)
class Provider:
    name: str
    location: str
    enabled: bool
    capabilities: tuple[str, ...]
    sends_off_device: bool
    model: str | None = None


def providers() -> list[Provider]:
    """Return the providers known to this Alfred Core instance."""
    return [
        Provider(
            name="ollama.chat",
            location="dell",
            enabled=True,
            capabilities=("chat", "summarise", "memory_answer"),
            sends_off_device=False,
            model=settings.chat_model,
        ),
        Provider(
            name="ollama.router",
            location="dell",
            enabled=True,
            capabilities=("route", "classify"),
            sends_off_device=False,
            model=settings.router_model,
        ),
        # Cloud providers are registered now so routing, policy and audit records
        # can refer to stable provider names before direct invocation is added.
        Provider(
            name="openai",
            location="cloud",
            enabled=False,
            capabilities=("reasoning", "research", "coding"),
            sends_off_device=True,
        ),
        Provider(
            name="claude",
            location="cloud",
            enabled=False,
            capabilities=("reasoning", "coding", "long_context"),
            sends_off_device=True,
        ),
    ]


def provider_registry() -> list[dict]:
    return [asdict(provider) for provider in providers()]


def get_provider(name: str) -> Provider | None:
    return next((provider for provider in providers() if provider.name == name), None)

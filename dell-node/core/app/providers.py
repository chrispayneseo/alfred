"""Provider metadata owned by Alfred Core.

The registry is declarative and secret-free: models may suggest work, but the
Core remains responsible for deciding whether a provider may receive a request.
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
    """Return providers known to this Core without exposing credentials."""
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
        Provider(
            name="openai",
            location="cloud",
            enabled=bool(settings.openai_api_key and settings.openai_model),
            capabilities=("reasoning", "research", "coding"),
            sends_off_device=True,
            model=settings.openai_model,
        ),
        Provider(
            name="claude",
            location="cloud",
            enabled=bool(settings.anthropic_api_key and settings.anthropic_model),
            capabilities=("reasoning", "coding", "long_context"),
            sends_off_device=True,
            model=settings.anthropic_model,
        ),
    ]


def provider_registry() -> list[dict]:
    return [asdict(provider) for provider in providers()]


def get_provider(name: str) -> Provider | None:
    return next((provider for provider in providers() if provider.name == name), None)


def enabled_cloud_providers() -> list[Provider]:
    return [provider for provider in providers() if provider.location == "cloud" and provider.enabled]

"""Phase 13 deterministic specialist model/tool orchestration policy.

The broker plans which already-registered specialist is appropriate and how much
context may be sent. It does not call providers, read secrets, resolve approvals,
or define tools. Cloud execution remains the only off-device model boundary.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

from fastapi import APIRouter, Query

from .privacy import is_private, needs_connected_data, needs_web_search
from .providers import enabled_cloud_providers, provider_registry

MODE = "specialist_orchestration_v1"
MAX_CLOUD_PROMPT_CHARS = 12_000
MAX_CONNECTED_CONTEXT_CHARS = 6_000
MAX_FALLBACKS = 1
router = APIRouter(tags=["core-specialist-orchestration"])

TaskClass = Literal["web_research", "coding", "long_reasoning", "general_reasoning", "connected_account", "local_preferred"]
PrivacyClass = Literal["local_only", "prompt_only_cloud_eligible", "private_requires_approval", "connected_requires_explicit"]

CODING_TERMS = (
    "code", "coding", "debug", "implement", "refactor", "python", "typescript",
    "javascript", "repository", "repo", "pull request", "architecture", "sql",
)
LONG_REASONING_TERMS = (
    "deep analysis", "deep research", "comprehensive", "investigate", "compare in depth",
    "strategy", "reason through", "long context",
)


@dataclass(frozen=True)
class SpecialistPlan:
    task_class: TaskClass
    privacy_class: PrivacyClass
    primary_provider: str
    fallback_providers: tuple[str, ...]
    web_search: bool
    max_prompt_chars: int
    max_connected_context_chars: int
    approval_required_before_cloud: bool
    memory_automatically_sent: bool
    fallback_is_automatic: bool
    reason: str


def classify_task(message: str) -> TaskClass:
    clean = message.strip()
    lowered = clean.casefold()
    if needs_connected_data(clean):
        return "connected_account"
    if needs_web_search(clean):
        return "web_research"
    if any(term in lowered for term in CODING_TERMS):
        return "coding"
    if len(clean) > 6000 or any(term in lowered for term in LONG_REASONING_TERMS):
        return "long_reasoning"
    if len(clean.split()) <= 12 and not any(word in lowered for word in ("analyse", "analyze", "research", "reason", "compare")):
        return "local_preferred"
    return "general_reasoning"


def privacy_class(message: str) -> PrivacyClass:
    clean = message.strip()
    if needs_connected_data(clean):
        return "connected_requires_explicit"
    if is_private(clean):
        return "private_requires_approval"
    return "prompt_only_cloud_eligible"


def _enabled() -> set[str]:
    return {provider.name for provider in enabled_cloud_providers()}


def _explicit_provider(message: str) -> str | None:
    lowered = message.casefold()
    if "use claude" in lowered:
        return "claude"
    if "use chatgpt" in lowered or "use openai" in lowered:
        return "openai"
    return None


def _provider_order(task: TaskClass, message: str) -> tuple[str, ...]:
    explicit = _explicit_provider(message)
    if explicit:
        return (explicit,)
    if task == "web_research":
        return ("openai",)
    if task in {"coding", "long_reasoning"}:
        return ("claude", "openai")
    return ("openai", "claude")


def plan(message: str) -> SpecialistPlan:
    clean = message.strip()
    task = classify_task(clean)
    privacy = privacy_class(clean)
    enabled = _enabled()
    order = _provider_order(task, clean)

    primary = next((name for name in order if name in enabled), order[0])
    fallback = tuple(
        name for name in order if name != primary and name in enabled
    )[:MAX_FALLBACKS]
    web = task == "web_research"
    approval = privacy in {"private_requires_approval", "connected_requires_explicit"}
    reason = {
        "web_research": "Live web research requires the OpenAI web-search adapter.",
        "coding": "Coding work prefers the configured coding specialist.",
        "long_reasoning": "Long reasoning prefers the configured long-context specialist.",
        "connected_account": "Connected-account work stays behind explicit Core data-access and cloud-transfer boundaries.",
        "local_preferred": "Short everyday work should stay local unless the owner explicitly requests cloud help.",
        "general_reasoning": "General cloud reasoning uses the first configured reasoning specialist.",
    }[task]
    return SpecialistPlan(
        task_class=task,
        privacy_class=privacy,
        primary_provider=primary,
        fallback_providers=fallback,
        web_search=web,
        max_prompt_chars=MAX_CLOUD_PROMPT_CHARS,
        max_connected_context_chars=MAX_CONNECTED_CONTEXT_CHARS,
        approval_required_before_cloud=approval,
        memory_automatically_sent=False,
        fallback_is_automatic=False,
        reason=reason,
    )


def choose_cloud_provider(message: str) -> str:
    """Compatibility helper used by cloud_execution; it performs no provider call."""
    return plan(message).primary_provider


def status() -> dict:
    return {
        "mode": MODE,
        "planning_only": True,
        "provider_calls": False,
        "registered_providers": [item["name"] for item in provider_registry()],
        "max_cloud_prompt_chars": MAX_CLOUD_PROMPT_CHARS,
        "max_connected_context_chars": MAX_CONNECTED_CONTEXT_CHARS,
        "max_fallbacks": MAX_FALLBACKS,
        "fallback_is_automatic": False,
        "memory_automatically_sent": False,
        "connected_data_automatically_sent": False,
        "existing_cloud_privacy_gate_reused": True,
        "existing_provider_execution_reused": True,
        "runtime_provider_definition": False,
        "new_executor": False,
    }


@router.get("/v1/core/specialists/status")
async def specialists_status():
    return status()


@router.get("/v1/core/specialists/plan")
async def specialists_plan(q: str = Query(min_length=1, max_length=12000)):
    return {"mode": MODE, "plan": asdict(plan(q)), "executed": False}

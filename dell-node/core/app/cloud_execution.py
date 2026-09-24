"""Policy-gated cloud model execution for Alfred Core.

Cloud providers are specialists, not authorities. This module selects/configures
them deterministically, blocks unapproved personal prompts, and audits only
metadata/fingerprints rather than raw prompt content.
"""

from __future__ import annotations

import hashlib
import json

from .cloud_providers import CloudProviderError, cloud_complete
from .db import connection, create_approval, record_audit, resolve_approval
from .privacy import is_private, needs_web_search
from .providers import enabled_cloud_providers, get_provider


CODING_TERMS = (
    "code", "coding", "debug", "implement", "refactor", "python", "typescript",
    "javascript", "repository", "repo", "pull request", "architecture",
)


def _fingerprint(value: dict) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def choose_provider(message: str) -> str:
    """Choose a specialist deterministically; availability is checked separately."""
    lowered = message.casefold()
    if "use claude" in lowered:
        return "claude"
    if "use chatgpt" in lowered or "use openai" in lowered:
        return "openai"
    if needs_web_search(message):
        return "openai"

    enabled = {provider.name for provider in enabled_cloud_providers()}
    if any(term in lowered for term in CODING_TERMS) and "claude" in enabled:
        return "claude"
    if "openai" in enabled:
        return "openai"
    if "claude" in enabled:
        return "claude"
    return "openai"


def _latest_approval(request_id: str, action: str, scope_hash: str) -> dict | None:
    with connection() as db:
        row = db.execute(
            """SELECT id, request_id, plan_id, action, summary, risk_level, state,
                      scope_hash, step_index, created_at, resolved_at
               FROM approvals
               WHERE request_id = ? AND plan_id IS NULL AND action = ? AND scope_hash = ?
               ORDER BY created_at DESC LIMIT 1""",
            (request_id, action, scope_hash),
        ).fetchone()
    return dict(row) if row else None


def _new_approval(request_id: str, provider: str, scope_hash: str) -> dict:
    label = "OpenAI" if provider == "openai" else "Claude"
    return create_approval(
        request_id,
        None,
        f"provider.{provider}",
        f"Send this request to {label}.",
        "external",
        scope_hash=scope_hash,
    )


async def execute_cloud_request(
    *,
    request_id: str,
    prompt: str,
    provider: str | None = None,
    confirmed: bool = False,
) -> dict:
    """Execute a cloud specialist request after privacy/configuration checks."""
    clean = prompt.strip()
    if not clean:
        return {"state": "failed", "error": "Prompt is required"}

    provider_name = provider or choose_provider(clean)
    provider_meta = get_provider(provider_name)
    web_search = needs_web_search(clean)

    if provider_meta is None or provider_meta.location != "cloud":
        return {"state": "provider_unavailable", "provider": provider_name, "reason": "Unknown cloud provider."}

    scope_hash = _fingerprint({
        "provider": provider_name,
        "prompt": clean,
        "web_search": web_search,
    })
    prompt_hash = hashlib.sha256(clean.encode("utf-8")).hexdigest()
    private = is_private(clean)

    # Privacy is evaluated before availability. A missing provider key must not
    # change whether the Core judges off-device transfer to require approval.
    if private:
        action = f"provider.{provider_name}"
        approval = _latest_approval(request_id, action, scope_hash)
        existed = approval is not None
        if approval is None:
            approval = _new_approval(request_id, provider_name, scope_hash)
        # Confirmation can resolve only the exact pending approval that existed
        # before this call. A changed prompt gets a new pending scope instead.
        if confirmed and existed and approval.get("state") == "pending":
            resolve_approval(approval["id"], True)
            approval = _latest_approval(request_id, action, scope_hash) or approval
            record_audit(
                "approval.resolved",
                {"approval_id": approval["id"], "approved": True, "source": "cloud_explicit_confirmation"},
                request_id,
            )
        if approval.get("state") != "approved":
            record_audit(
                "cloud.approval_required",
                {"provider": provider_name, "scope_hash": scope_hash, "prompt_hash": prompt_hash},
                request_id,
            )
            return {
                "state": "approval_required",
                "provider": provider_name,
                "model": provider_meta.model,
                "approval": approval,
                "memory_sent": False,
            }

    if not provider_meta.enabled:
        return {
            "state": "provider_unavailable",
            "provider": provider_name,
            "model": provider_meta.model,
            "reason": "Provider is not configured on Alfred Core.",
            "memory_sent": False,
        }
    if web_search and provider_name != "openai":
        return {
            "state": "provider_unavailable",
            "provider": provider_name,
            "reason": "This request needs live web search and the selected provider adapter does not expose it.",
            "memory_sent": False,
        }

    record_audit(
        "cloud.started",
        {
            "provider": provider_name,
            "model": provider_meta.model,
            "prompt_hash": prompt_hash,
            "web_search": web_search,
            "private": private,
        },
        request_id,
    )
    try:
        result = await cloud_complete(
            provider_name,
            clean,
            web_search=web_search,
        )
    except CloudProviderError as exc:
        record_audit(
            "cloud.failed",
            {
                "provider": provider_name,
                "code": exc.code,
                "status_code": exc.status_code,
                "prompt_hash": prompt_hash,
            },
            request_id,
        )
        return {
            "state": "failed",
            "provider": provider_name,
            "error_type": exc.code,
            "status_code": exc.status_code,
            "memory_sent": False,
        }
    except Exception as exc:
        record_audit(
            "cloud.failed",
            {"provider": provider_name, "error_type": type(exc).__name__, "prompt_hash": prompt_hash},
            request_id,
        )
        return {
            "state": "failed",
            "provider": provider_name,
            "error_type": type(exc).__name__,
            "memory_sent": False,
        }

    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    record_audit(
        "cloud.completed",
        {
            "provider": provider_name,
            "model": result.get("model"),
            "prompt_hash": prompt_hash,
            "web_search": bool(result.get("web_search")),
            "input_tokens": int(usage.get("input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
        },
        request_id,
    )
    return {
        "state": "completed",
        "provider": provider_name,
        "model": result.get("model"),
        "reply": result.get("reply"),
        "usage": usage,
        "web_search": bool(result.get("web_search")),
        "memory_sent": False,
    }

"""Phase 4K hardening and content-minimised acceptance status.

This module does not perform connected reads, model calls, outbound delivery or
mutations. It composes local status already produced by Phase 4 components and
checks the safety/privacy invariants that must remain true for the proactive
stack to be considered accepted.
"""

from __future__ import annotations

from typing import Callable


ACCEPTANCE_MODE = "phase4_acceptance_v1"
_REGISTERED = False


def _safe(call: Callable[[], dict], fallback: dict) -> dict:
    try:
        value = call()
    except Exception as exc:
        result = dict(fallback)
        result["available"] = False
        result["error_type"] = type(exc).__name__
        return result
    return value if isinstance(value, dict) else dict(fallback)


def acceptance_status() -> dict:
    """Return a compact, connected-content-free Phase 4 acceptance snapshot."""
    from . import (
        proactive,
        proactive_delivery,
        proactive_feedback,
        proactive_preferences,
        proactive_reasoning,
        proactive_relevance,
        proactive_schedule,
    )

    observation = _safe(proactive.status, {"enabled": False, "last_run": None, "active_items": 0})
    relevance = _safe(proactive_relevance.relevance_status, {"mode": "unavailable"})
    reasoning = _safe(proactive_reasoning.reasoning_status, {"mode": "unavailable"})
    feedback = _safe(proactive_feedback.status, {"mode": "unavailable"})
    delivery = _safe(proactive_delivery.delivery_status, {"configured": False, "enabled": False})
    schedule = _safe(proactive_schedule.due_status, {"enabled": False, "scheduled_time": None})
    preferences = _safe(proactive_preferences.current, {"enabled": False, "source": "unavailable"})

    last_run = observation.get("last_run") if isinstance(observation.get("last_run"), dict) else None
    source_states: dict[str, dict] = {}
    if last_run:
        sources = last_run.get("sources") if isinstance(last_run.get("sources"), dict) else {}
        for name in ("tasks", "calendar", "gmail"):
            raw = sources.get(name) if isinstance(sources.get(name), dict) else {}
            source_states[name] = {
                "state": str(raw.get("state") or "unknown"),
                "count": int(raw.get("count", 0) or 0),
            }

    checks = {
        "relevance_local": (
            str(relevance.get("mode") or "") == "deterministic_local"
            and bool(relevance.get("cloud_models", False)) is False
            and bool(relevance.get("raw_gmail_metadata_stored", True)) is False
        ),
        "reasoning_bounded": (
            str(reasoning.get("mode") or "") == "deterministic_cross_source_v1"
            and bool(reasoning.get("creates_urgent", True)) is False
            and bool(reasoning.get("cloud_models", True)) is False
            and str(reasoning.get("mutation_targets") or "") == "existing_items_only"
        ),
        "feedback_bounded": (
            str(feedback.get("mode") or "") == "explicit_local_v1"
            and bool(feedback.get("creates_urgent", True)) is False
            and bool(feedback.get("demotes_urgent", True)) is False
            and bool(feedback.get("cloud_models", True)) is False
            and bool(feedback.get("stores_connected_content", True)) is False
        ),
        "delivery_generic_only": (
            str(delivery.get("content_policy") or "") == "generic_only"
            and str(delivery.get("channel") or "") == "ntfy_generic"
        ),
        "no_secret_destination_exposed": "topic" not in delivery,
        "owner_settings_available": str(preferences.get("source") or "") in {"environment_defaults", "local_override"},
    }

    last_run_state = str((last_run or {}).get("state") or "none")
    unavailable_sources = sorted(
        name for name, state in source_states.items()
        if state.get("state") == "unavailable"
    )
    failed_sources = sorted(
        name for name, state in source_states.items()
        if state.get("state") not in {"ready", "not_configured", "unavailable", "unknown"}
    )

    invariants_pass = all(checks.values())
    hard_failure = last_run_state == "failed" or bool(failed_sources) or not invariants_pass
    enabled = bool(preferences.get("enabled", observation.get("enabled", False)))
    if hard_failure:
        state = "failed"
    elif not enabled:
        state = "disabled"
    elif unavailable_sources or last_run_state == "degraded":
        state = "degraded"
    else:
        state = "ready"

    return {
        "phase": "4K",
        "mode": ACCEPTANCE_MODE,
        "state": state,
        "accepted": bool(invariants_pass and last_run_state != "failed"),
        "enabled": enabled,
        "checks": checks,
        "observation": {
            "last_run_state": last_run_state,
            "active_items": int(observation.get("active_items", 0) or 0),
            "sources": source_states,
            "degraded_sources": unavailable_sources,
        },
        "modes": {
            "relevance": relevance.get("gmail") or relevance.get("mode"),
            "reasoning": reasoning.get("mode"),
            "feedback": feedback.get("mode"),
        },
        "delivery": {
            "enabled": bool(delivery.get("enabled", False)),
            "configured": bool(delivery.get("configured", False)),
            "channel": delivery.get("channel"),
            "content_policy": delivery.get("content_policy"),
            "morning_brief_enabled": bool(delivery.get("morning_brief_enabled", False)),
        },
        "schedule": {
            "enabled": bool(schedule.get("enabled", False)),
            "scheduled_time": schedule.get("scheduled_time"),
            "today_generated": bool(schedule.get("today_generated", False)),
        },
        "feedback": {
            "window_days": int(feedback.get("window_days", 0) or 0),
            "dismissals": int(feedback.get("dismissals", 0) or 0),
            "snoozes": int(feedback.get("snoozes", 0) or 0),
            "learned_kinds": int(feedback.get("learned_kinds", 0) or 0),
        },
        "privacy": {
            "cloud_models": False,
            "raw_gmail_metadata_stored": False,
            "connected_content_in_status": False,
            "ntfy_topic_exposed": False,
        },
        "safety": {
            "reasoning_can_create_urgent": False,
            "feedback_can_demote_urgent": False,
            "mutation_targets": "existing_items_only",
            "delivery_content": "generic_only",
        },
    }


def register_routes() -> None:
    global _REGISTERED
    if _REGISTERED:
        return
    from . import proactive

    @proactive.router.get("/acceptance")
    async def phase4_acceptance():
        return acceptance_status()

    _REGISTERED = True

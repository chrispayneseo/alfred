#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from unittest.mock import patch

from app import proactive, proactive_acceptance, proactive_preferences

# This smoke runs in a fresh helper process. Apply durable owner overrides so
# status reflects the effective settings used by the long-running Core.
proactive_preferences.apply_runtime_preferences()

status = proactive_acceptance.acceptance_status()
paths = {route.path for route in proactive.router.routes}

assert status.get("phase") == "4K"
assert status.get("mode") == "phase4_acceptance_v1"
assert status.get("accepted") is True
assert status.get("state") in {"ready", "degraded", "disabled"}
assert all(bool(value) for value in status.get("checks", {}).values())
assert status.get("modes", {}).get("relevance") == "deterministic_metadata_v2"
assert status.get("modes", {}).get("reasoning") == "deterministic_cross_source_v1"
assert status.get("modes", {}).get("feedback") == "explicit_local_v1"
assert status.get("privacy", {}).get("cloud_models") is False
assert status.get("privacy", {}).get("raw_gmail_metadata_stored") is False
assert status.get("privacy", {}).get("connected_content_in_status") is False
assert status.get("privacy", {}).get("ntfy_topic_exposed") is False
assert status.get("safety", {}).get("reasoning_can_create_urgent") is False
assert status.get("safety", {}).get("feedback_can_demote_urgent") is False
assert status.get("safety", {}).get("mutation_targets") == "existing_items_only"
assert status.get("safety", {}).get("delivery_content") == "generic_only"
assert "/v1/core/proactive/acceptance" in paths

# The acceptance surface itself must never contain connected-source content or
# the ntfy topic. Check keys recursively without printing the payload.
forbidden = {"title", "summary", "subject", "sender", "snippet", "body", "source_ref", "topic"}
def inspect(value):
    if isinstance(value, dict):
        for key, child in value.items():
            assert str(key).casefold() not in forbidden
            inspect(child)
    elif isinstance(value, list):
        for child in value:
            inspect(child)
inspect(status)

# A connected source outage must degrade health rather than invalidate the
# Phase 4 safety contract or break briefing/delivery code paths.
live_observation = proactive.status()
synthetic_observation = dict(live_observation)
synthetic_observation["enabled"] = True
synthetic_observation["last_run"] = {
    "state": "degraded",
    "sources": {
        "tasks": {"state": "ready", "count": 0},
        "calendar": {"state": "unavailable", "error_type": "TimeoutError"},
        "gmail": {"state": "ready", "count": 0},
    },
}
with patch.object(proactive, "status", return_value=synthetic_observation):
    degraded = proactive_acceptance.acceptance_status()
assert degraded.get("state") == "degraded"
assert degraded.get("accepted") is True
assert degraded.get("observation", {}).get("degraded_sources") == ["calendar"]

print("PASS: Phase 4K end-to-end acceptance contract is healthy")
print("PASS: Acceptance status contains no connected-source content or ntfy topic")
print("PASS: Cross-source reasoning, feedback learning and delivery safety invariants hold")
print("PASS: Connected-source outages degrade safely instead of failing the proactive stack")
print()
print("Phase 4 acceptance:")
print(f"  state: {status.get('state')}")
print(f"  accepted: {str(bool(status.get('accepted'))).lower()}")
print(f"  observation: {status.get('observation', {}).get('last_run_state')}")
print(f"  relevance: {status.get('modes', {}).get('relevance')}")
print(f"  reasoning: {status.get('modes', {}).get('reasoning')}")
print(f"  feedback: {status.get('modes', {}).get('feedback')}")
print(f"  delivery configured: {str(bool(status.get('delivery', {}).get('configured'))).lower()}")
print(f"  delivery content: {status.get('delivery', {}).get('content_policy')}")
print()
print("Phase 4K smoke completed without connected reads, outbound delivery or mutation.")
PY

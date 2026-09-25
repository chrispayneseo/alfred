#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app import proactive, proactive_brief, proactive_reasoning

items = [
    {
        "id": "task-safe",
        "source": "tasks",
        "kind": "due_today",
        "priority": 84,
        "title": "Prepare renewal invoice",
        "summary": "Due today.",
    },
    {
        "id": "calendar-safe",
        "source": "calendar",
        "kind": "calendar_upcoming",
        "priority": 82,
        "title": "Renewal invoice review",
        "summary": "Starts at 15:00.",
    },
    {
        "id": "gmail-safe",
        "source": "gmail",
        "kind": "gmail_finance",
        "priority": 76,
        "title": "Money or payment email",
        "summary": "1 unread message looks related to a payment or money matter.",
    },
]

result = proactive_reasoning.apply_cross_source_reasoning(items)
status = proactive_reasoning.reasoning_status()
original_ids = {item["id"] for item in items}
reasoned_ids = {item["id"] for item in result["items"]}

assert status["mode"] == "deterministic_cross_source_v1"
assert status["cross_source"] is True
assert status["creates_urgent"] is False
assert status["cloud_models"] is False
assert status["mutation_targets"] == "existing_items_only"
assert result["cluster_count"] >= 2
assert result["boosted_items"] >= 2
assert original_ids == reasoned_ids
assert all(
    int(item["priority"]) < 90
    for item in result["items"]
    if int(item["base_priority"]) < 90
)

now = datetime(2026, 9, 25, 13, 0, tzinfo=ZoneInfo("Europe/London"))
with patch.object(proactive, "feed", return_value={
    "items": items,
    "quiet_hours": False,
    "delivery": "disabled",
}):
    brief = proactive_brief.build_brief(now=now)

assert brief["reasoning"]["mode"] == "deterministic_cross_source_v1"
assert brief["reasoning"]["cluster_count"] >= 2
assert brief["reasoning"]["boosted_items"] >= 2
assert brief["reasoning"]["creates_urgent"] is False
assert brief["reasoning"]["cloud_models"] is False
assert all(item["id"] in original_ids for item in brief["items"])

print("PASS: Phase 4I deterministic cross-source reasoning is active")
print("PASS: Independent sources can raise bounded relevance without synthetic items")
print("PASS: Cross-source reasoning cannot create cooldown-bypass urgency")
print("PASS: Reasoning stays local and model-free")
print()
print("Reasoning state:")
print(f"  mode: {status['mode']}")
print(f"  clusters in fixture: {result['cluster_count']}")
print(f"  boosted items in fixture: {result['boosted_items']}")
print(f"  creates urgent: {str(status['creates_urgent']).lower()}")
print(f"  cloud models: {str(status['cloud_models']).lower()}")
print(f"  mutation targets: {status['mutation_targets']}")
print()
print("Phase 4I smoke completed without network access or external mutation.")
PY

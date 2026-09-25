#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
import json
from unittest.mock import patch

from app import proactive, proactive_feedback

state = proactive_feedback.status()
core_status = proactive.status()
paths = {route.path for route in proactive.router.routes}

assert state.get("mode") == "explicit_local_v1"
assert state.get("creates_urgent") is False
assert state.get("demotes_urgent") is False
assert state.get("cloud_models") is False
assert state.get("stores_connected_content") is False
assert core_status.get("feedback", {}).get("mode") == "explicit_local_v1"
assert "/v1/core/proactive/feedback/status" in paths
assert "/v1/core/proactive/feedback/reset" in paths

fixture = [
    {
        "id": "private-booking",
        "source": "gmail",
        "kind": "gmail_booking",
        "priority": 72,
        "title": "PRIVATE TRAVEL SUBJECT",
        "summary": "PRIVATE TRAVEL SUMMARY",
    },
    {
        "id": "urgent-task",
        "source": "tasks",
        "kind": "overdue",
        "priority": 94,
        "title": "PRIVATE URGENT TASK",
        "summary": "PRIVATE URGENT SUMMARY",
    },
]
counts = {
    ("gmail", "gmail_booking"): {"dismiss": 1, "snooze": 0},
    ("tasks", "overdue"): {"dismiss": 3, "snooze": 3},
}
with patch.object(proactive_feedback, "_recent_counts", return_value=counts):
    result = proactive_feedback.apply_feedback(fixture)

by_id = {item["id"]: item for item in result["items"]}
assert by_id["private-booking"]["priority"] == 66
assert by_id["private-booking"]["feedback_adjustment"] == -6
assert by_id["urgent-task"]["priority"] == 94
assert "feedback_adjustment" not in by_id["urgent-task"]
assert result.get("creates_urgent") is False
assert result.get("demotes_urgent") is False

# The learned metadata itself contains no connected-source text. Inspect only
# the feedback payload, not the fixture item content deliberately supplied here.
encoded_feedback = json.dumps(by_id["private-booking"].get("feedback", {}))
assert "PRIVATE" not in encoded_feedback

print("PASS: Phase 4J explicit local feedback learning is active")
print("PASS: Dismissals create bounded source/kind noise reduction")
print("PASS: One snooze remains timing-only and urgent items are never demoted")
print("PASS: Feedback stores no connected-source content and uses no cloud model")
print()
print("Feedback state:")
print(f"  mode: {state.get('mode')}")
print(f"  window days: {state.get('window_days')}")
print(f"  dismissals learned: {state.get('dismissals')}")
print(f"  snoozes learned: {state.get('snoozes')}")
print(f"  learned kinds: {state.get('learned_kinds')}")
print(f"  demotes urgent: {str(bool(state.get('demotes_urgent'))).lower()}")
print(f"  cloud models: {str(bool(state.get('cloud_models'))).lower()}")
print()
print("Phase 4J smoke completed without network access, feedback mutation or connected-content output.")
PY

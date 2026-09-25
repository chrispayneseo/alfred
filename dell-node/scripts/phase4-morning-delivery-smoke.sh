#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import proactive_delivery, proactive_preferences

proactive_preferences.apply_runtime_preferences()
prefs = proactive_preferences.current()
status = proactive_delivery.delivery_status()
paths = {route.path for route in proactive_delivery.proactive.router.routes}

assert status.get("channel") == "ntfy_generic"
assert status.get("content_policy") == "generic_only"
assert status.get("destination") == "today"
assert isinstance(status.get("configured"), bool)
assert isinstance(status.get("enabled"), bool)
assert isinstance(status.get("morning_brief_enabled"), bool)
assert status.get("enabled") == bool(prefs.get("push_enabled"))
assert status.get("morning_brief_enabled") == bool(prefs.get("morning_brief_push_enabled"))
assert "/v1/core/proactive/delivery/test" in paths
assert "topic" not in status
assert "title" not in status
assert "summary" not in status

print("PASS: Phase 4G owner-triggered test nudge endpoint is present")
print("PASS: Morning brief nudges are separately controlled and content-minimised")
print("PASS: Phase 4G status exposes no ntfy topic or connected-source content")
print()
print("Phase 4G delivery state:")
print(f"  proactive pushes: {str(bool(status.get('enabled'))).lower()}")
print(f"  ntfy configured: {str(bool(status.get('configured'))).lower()}")
print(f"  morning brief nudge: {str(bool(status.get('morning_brief_enabled'))).lower()}")
print(f"  test nudge available: {str(bool(status.get('enabled') and status.get('configured'))).lower()}")
print(f"  delivered count: {int(status.get('delivered_count', 0))}")
print()
print("Phase 4G smoke completed without attempting or performing delivery.")
PY

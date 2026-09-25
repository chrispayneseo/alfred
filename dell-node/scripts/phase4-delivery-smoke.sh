#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import proactive_delivery, proactive_preferences

preferences = proactive_preferences.current()
status = proactive_delivery.delivery_status()

assert status.get("channel") == "ntfy_generic"
assert status.get("content_policy") == "generic_only"
assert status.get("destination") == "today"
assert isinstance(status.get("configured"), bool)
assert isinstance(status.get("enabled"), bool)
assert status.get("enabled") == bool(preferences.get("push_enabled"))
assert "topic" not in status
assert "title" not in status
assert "summary" not in status

print("PASS: Phase 4F delivery boundary is present")
print("PASS: Proactive pushes are separately opt-in and policy-gated")
print("PASS: Delivery status is content-minimised and does not expose the ntfy topic")
print()
print("Delivery state:")
print(f"  enabled: {str(bool(status.get('enabled'))).lower()}")
print(f"  ntfy configured: {str(bool(status.get('configured'))).lower()}")
print(f"  channel: {status.get('channel')}")
print(f"  content policy: {status.get('content_policy')}")
print(f"  delivered count: {int(status.get('delivered_count', 0))}")
last = status.get("last") or {}
print(f"  last state: {last.get('state') or 'none'}")
print()
print("Phase 4F smoke completed without attempting or performing delivery.")
PY

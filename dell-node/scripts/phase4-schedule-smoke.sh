#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
import asyncio

from app import proactive_schedule
from app.config import settings

status_before = proactive_schedule.due_status()
first = asyncio.run(proactive_schedule.generate_now())
second = proactive_schedule.generate_snapshot()
latest = proactive_schedule.latest()
status_after = proactive_schedule.due_status()

assert first.get("brief")
assert second.get("brief")
assert latest
assert first["brief"].get("id") == second["brief"].get("id") == latest.get("id")
assert latest.get("delivery") == "disabled"
assert latest.get("synthesis") == "deterministic_local"
assert second.get("generated") is False
assert second.get("reason") == "already_generated"
assert status_after.get("today_generated") is True
assert status_after.get("delivery") == "disabled"

counts = latest.get("counts", {})
print("PASS: Phase 4C durable morning brief generated locally")
print("PASS: Once-per-local-day idempotency verified")
print("PASS: Morning brief schedule remains delivery-disabled")
print()
print("Morning brief state:")
print(f"  configured time: {status_after.get('scheduled_time')}")
print(f"  generated this run: {str(bool(first.get('generated'))).lower()}")
print(f"  total: {int(counts.get('total', 0))}")
print(f"  urgent: {int(counts.get('urgent', 0))}")
print(f"  important: {int(counts.get('important', 0))}")
print(f"  later: {int(counts.get('later', 0))}")
print(f"  background currently enabled: {str(bool(settings.proactive_enabled)).lower()}")
print()
print("Phase 4C smoke completed without printing brief content or performing delivery.")
PY

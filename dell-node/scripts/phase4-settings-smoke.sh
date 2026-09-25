#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import proactive, proactive_preferences, proactive_schedule

prefs = proactive_preferences.current()

assert prefs.get("delivery") == "disabled"
assert prefs.get("source") in {"environment_defaults", "local_override"}
assert isinstance(prefs.get("enabled"), bool)
assert isinstance(prefs.get("morning_brief_enabled"), bool)
assert 300 <= int(prefs.get("poll_seconds", 0)) <= 3600
assert 0 <= int(prefs.get("min_priority", -1)) <= 100
assert 0 <= int(prefs.get("cooldown_minutes", -1)) <= 1440
assert len(str(prefs.get("quiet_start", ""))) == 5
assert len(str(prefs.get("quiet_end", ""))) == 5
assert len(str(prefs.get("morning_brief_time", ""))) == 5

# The effective runtime modules must reflect the durable preference layer.
assert bool(proactive.settings.proactive_enabled) == bool(prefs["enabled"])
assert int(proactive.settings.proactive_poll_seconds) == int(prefs["poll_seconds"])
assert str(proactive.settings.proactive_quiet_start) == str(prefs["quiet_start"])
assert str(proactive.settings.proactive_quiet_end) == str(prefs["quiet_end"])
assert int(proactive.settings.proactive_min_priority) == int(prefs["min_priority"])
assert int(proactive.settings.proactive_cooldown_minutes) == int(prefs["cooldown_minutes"])
assert bool(proactive_schedule.settings.proactive_morning_brief_enabled) == bool(prefs["morning_brief_enabled"])
assert str(proactive_schedule.settings.proactive_morning_brief_time) == str(prefs["morning_brief_time"])

print("PASS: Phase 4E proactive preferences are durable and active")
print("PASS: Environment values remain defaults until locally overridden")
print("PASS: Proactive settings remain delivery-disabled")
print()
print("Proactive settings state:")
print(f"  source: {prefs['source']}")
print(f"  enabled: {str(bool(prefs['enabled'])).lower()}")
print(f"  poll seconds: {int(prefs['poll_seconds'])}")
print(f"  quiet hours: {prefs['quiet_start']}–{prefs['quiet_end']}")
print(f"  minimum priority: {int(prefs['min_priority'])}")
print(f"  cooldown minutes: {int(prefs['cooldown_minutes'])}")
print(f"  morning brief: {str(bool(prefs['morning_brief_enabled'])).lower()} at {prefs['morning_brief_time']}")
print()
print("Phase 4E smoke completed without changing settings or performing delivery.")
PY

#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import proactive, proactive_brief

brief = proactive_brief.build_brief(limit=8)
decision = proactive_brief.interruption_decision()

assert brief.get("synthesis") == "deterministic_local"
assert brief.get("delivery") == "disabled"
assert decision.get("delivery") == "disabled"
assert decision.get("decision") in {
    "hold_quiet_hours", "nothing_to_surface", "hold_cooldown", "surface_candidate"
}

counts = brief.get("counts", {})
print("PASS: Phase 4 deterministic brief built locally")
print("PASS: Interruption policy evaluated with delivery disabled")
print()
print("Brief state:")
print(f"  total: {int(counts.get('total', 0))}")
print(f"  urgent: {int(counts.get('urgent', 0))}")
print(f"  important: {int(counts.get('important', 0))}")
print(f"  later: {int(counts.get('later', 0))}")
print(f"  interruption: {decision.get('decision')}")
print()
print("Phase 4B smoke completed without printing feed content or performing delivery.")
PY

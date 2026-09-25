#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
import json

from app import proactive, proactive_relevance

status = proactive.status()
relevance_status = status.get("relevance") or {}

assert relevance_status.get("mode") == "deterministic_local"
assert relevance_status.get("gmail") == "deterministic_metadata_v1"
assert relevance_status.get("stores_raw_gmail_metadata") is False
assert relevance_status.get("cloud_models") is False

private_subject = "ACTION REQUIRED: confidential family paperwork"
private_sender = "Private Sender <private-person@example.com>"
private_snippet = "Please respond with secret reference ABC-123."

result = proactive_relevance.gmail_relevance([{
    "id": "private-id",
    "from": private_sender,
    "subject": private_subject,
    "snippet": private_snippet,
}])
encoded = json.dumps(result)

assert result.get("classified") == 1
assert result.get("other") == 0
assert result.get("categories")
assert max(int(item.get("priority", 0)) for item in result["categories"]) < 90
assert "confidential family paperwork" not in encoded
assert "private-person@example.com" not in encoded
assert "ABC-123" not in encoded

feed = proactive.feed(limit=100)
for item in feed.get("items", []):
    if item.get("source") == "gmail":
        assert item.get("source_ref") is None

print("PASS: Phase 4H deterministic local relevance is active")
print("PASS: Gmail metadata reduces to generic categories before storage")
print("PASS: Gmail relevance alone cannot enter the urgent cooldown-bypass band")
print("PASS: No cloud model or raw Gmail metadata is used by the relevance layer")
print()
print("Relevance state:")
print(f"  mode: {relevance_status.get('mode')}")
print(f"  gmail: {relevance_status.get('gmail')}")
print(f"  raw Gmail metadata stored: {str(bool(relevance_status.get('stores_raw_gmail_metadata'))).lower()}")
print(f"  cloud models: {str(bool(relevance_status.get('cloud_models'))).lower()}")
print()
print("Phase 4H smoke completed without network access, connected-content output or mutation.")
PY

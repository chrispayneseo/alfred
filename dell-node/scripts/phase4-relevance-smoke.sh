#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
import json

from app import proactive, proactive_relevance

status = proactive.status()
relevance_status = status.get("relevance") or {}

assert relevance_status.get("mode") == "deterministic_local"
assert relevance_status.get("gmail") == "deterministic_metadata_v2"
assert relevance_status.get("stores_raw_gmail_metadata") is False
assert relevance_status.get("cloud_models") is False

private_subject = "Please review and sign confidential family paperwork"
private_sender = "Private Sender <private-person@example.com>"
private_snippet = "Signature required for secret reference ABC-123."

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
assert result.get("mode") == "deterministic_metadata_v2"
assert max(int(item.get("priority", 0)) for item in result["categories"]) < 90
assert "confidential family paperwork" not in encoded
assert "private-person@example.com" not in encoded
assert "ABC-123" not in encoded

# Broader real-world variants should classify without source content escaping.
variants = [
    ({"subject": "New login detected", "snippet": "Check this login attempt"}, "security"),
    ({"subject": "Your payment was received", "snippet": "Receipt available"}, "finance"),
    ({"subject": "Your booking details", "snippet": "Travel information enclosed"}, "booking"),
    ({"subject": "Your order is on its way", "snippet": "Track your parcel"}, "delivery"),
]
for message, expected in variants:
    assert proactive_relevance.gmail_category(message) == expected

feed = proactive.feed(limit=100)
for item in feed.get("items", []):
    if item.get("source") == "gmail":
        assert item.get("source_ref") is None

print("PASS: Phase 4H deterministic local relevance v2 is active")
print("PASS: Broader real-world Gmail wording classifies into generic categories")
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

#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${ALFRED_BASE_URL:-http://127.0.0.1:8080}"
PROJECT_DIR="${ALFRED_PROJECT_DIR:-/opt/alfred-node}"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

read_api_key() {
  if [[ -n "${ALFRED_API_KEY:-}" ]]; then
    printf '%s' "$ALFRED_API_KEY"
    return
  fi
  python3 - "$PROJECT_DIR/.env" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
for raw in path.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() == "ALFRED_API_KEY":
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        print(value, end="")
        raise SystemExit(0)
raise SystemExit(2)
PY
}

API_KEY="$(read_api_key)" || fail "Could not load ALFRED_API_KEY"
[[ -n "$API_KEY" ]] || fail "ALFRED_API_KEY is empty"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

get_json() {
  local path="$1" output="$2"
  local code
  code="$(curl -sS -o "$output" -w '%{http_code}' -H "X-Alfred-Key: $API_KEY" "$BASE_URL$path")" || fail "GET $path failed"
  [[ "$code" == "200" ]] || fail "GET $path returned HTTP $code"
}

post_request() {
  local message="$1" output="$2"
  local payload code
  payload="$(python3 - "$message" <<'PY'
import json, sys
print(json.dumps({"channel": "api", "message": sys.argv[1]}))
PY
)"
  code="$(curl -sS -o "$output" -w '%{http_code}' \
    -H "X-Alfred-Key: $API_KEY" -H 'Content-Type: application/json' \
    -d "$payload" "$BASE_URL/v1/requests")" || fail "Request failed"
  [[ "$code" == "200" ]] || fail "Request returned HTTP $code"
}

caps="$TMP_DIR/capabilities.json"
get_json "/v1/core/capabilities" "$caps"
python3 - "$caps" <<'PY' || fail "Calendar/Gmail capabilities are not ready"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
items = {item["id"]: item for item in obj.get("integrations", [])}
for integration_id in ("google_calendar", "gmail"):
    item = items.get(integration_id)
    assert isinstance(item, dict), integration_id
    assert item.get("state") == "ready", (integration_id, item.get("state"))
calendar = items["google_calendar"]
assert any(c.get("action") == "calendar.events.list" and c.get("enabled") for c in calendar.get("capabilities", []))
gmail = items["gmail"]
assert any(c.get("action") == "email.messages.search" and c.get("enabled") for c in gmail.get("capabilities", []))
PY
pass "Calendar and Gmail read capabilities are ready"

calendar="$TMP_DIR/calendar.json"
post_request "What's on my calendar tomorrow?" "$calendar"
python3 - "$calendar" <<'PY' || fail "Calendar natural-language read failed"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
assert obj.get("decision") == "tool"
assert obj.get("tool_action") == "calendar.events.list"
assert obj.get("integration") == "google_calendar"
assert obj.get("provider") == "integration:google_calendar"
assert obj.get("memory_sent") is False
print(f"  Calendar sources: {len(obj.get('sources') or [])}")
PY
pass "Calendar natural-language read"

gmail="$TMP_DIR/gmail.json"
post_request "Find unread emails" "$gmail"
python3 - "$gmail" <<'PY' || fail "Gmail natural-language read failed"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
assert obj.get("decision") == "tool"
assert obj.get("tool_action") == "email.messages.search"
assert obj.get("integration") == "gmail"
assert obj.get("provider") == "integration:gmail"
assert obj.get("memory_sent") is False
print(f"  Gmail sources: {len(obj.get('sources') or [])}")
PY
pass "Gmail natural-language read"

bundle="$TMP_DIR/bundle.json"
post_request "Show my calendar tomorrow and find unread emails" "$bundle"
python3 - "$bundle" <<'PY' || fail "Calendar + Gmail multi-read failed"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
assert obj.get("decision") == "tool"
assert obj.get("tool_action") == "multi_read"
assert obj.get("integration") == "multiple"
assert obj.get("provider") == "integration:multi"
assert obj.get("memory_sent") is False
sources = obj.get("sources") or []
integrations = {item.get("integration") for item in sources if isinstance(item, dict)}
# Empty result sets are valid, so provenance may be absent when both sources are empty.
assert integrations <= {"google_calendar", "gmail"}
print(f"  Combined sources: {len(sources)}")
PY
pass "Deterministic Calendar + Gmail multi-read"

printf '\nGoogle live smoke completed without printing connected content or performing mutations.\n'

#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${ALFRED_BASE_URL:-http://127.0.0.1:8080}"
PROJECT_DIR="${ALFRED_PROJECT_DIR:-/opt/alfred-node}"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$1"
}

read_api_key() {
  if [[ -n "${ALFRED_API_KEY:-}" ]]; then
    printf '%s' "$ALFRED_API_KEY"
    return
  fi
  local env_file="$PROJECT_DIR/.env"
  [[ -r "$env_file" ]] || fail "ALFRED_API_KEY is not set and $env_file is not readable"
  python3 - "$env_file" <<'PY'
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

request_json() {
  local method="$1"
  local path="$2"
  local output="$3"
  local code
  code="$(curl -sS -o "$output" -w '%{http_code}' -X "$method" \
    -H "X-Alfred-Key: $API_KEY" \
    "$BASE_URL$path")" || fail "Request failed for $path"
  [[ "$code" == "200" ]] || fail "$path returned HTTP $code"
}

health="$TMP_DIR/health.json"
code="$(curl -sS -o "$health" -w '%{http_code}' "$BASE_URL/health")" || fail "Health request failed"
[[ "$code" == "200" ]] || fail "/health returned HTTP $code"
python3 - "$health" <<'PY' || fail "Core health does not expose the Phase 4 proactive boundary"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
value = (obj.get("core") or {}).get("proactive_assistant")
assert value in {"available_disabled", "observation_feed"}
PY
pass "Phase 4 proactive boundary is present"

status="$TMP_DIR/status.json"
request_json GET "/v1/core/proactive/status" "$status"
python3 - "$status" <<'PY' || fail "Proactive status is invalid"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
assert obj.get("phase") == 4
assert obj.get("mode") == "observation_feed"
assert obj.get("delivery") == "disabled"
assert isinstance(obj.get("quiet_hours"), dict)
assert isinstance(obj.get("active_items"), int)
PY
pass "Proactive status is local observation-only"

refresh="$TMP_DIR/refresh.json"
request_json POST "/v1/core/proactive/refresh" "$refresh"
python3 - "$refresh" <<'PY' || fail "Proactive refresh failed validation"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
assert obj.get("state") in {"completed", "degraded"}
assert isinstance(obj.get("signal_count"), int)
sources = obj.get("sources") or {}
assert set(sources) == {"tasks", "calendar", "gmail"}
for value in sources.values():
    assert value.get("state") in {"ready", "not_configured", "unavailable"}
PY
pass "Deterministic proactive refresh completed"

feed="$TMP_DIR/feed.json"
request_json GET "/v1/core/proactive/feed?limit=20" "$feed"
python3 - "$feed" "$API_KEY" <<'PY' || fail "Proactive feed failed privacy/safety checks"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
secret = sys.argv[2]
assert obj.get("delivery") == "disabled"
assert isinstance(obj.get("count"), int)
items = obj.get("items") or []
assert isinstance(items, list)
for item in items:
    assert item.get("source") in {"tasks", "calendar", "gmail"}
    assert 0 <= int(item.get("priority", -1)) <= 100
    for forbidden in ("body", "subject", "from", "to", "arguments", "scope_hash"):
        assert forbidden not in item
encoded = json.dumps(obj)
assert secret not in encoded
PY
pass "Proactive feed is authenticated, bounded and content-minimised"

python3 - "$refresh" "$feed" <<'PY'
import json, sys
refresh = json.load(open(sys.argv[1], encoding="utf-8"))
feed = json.load(open(sys.argv[2], encoding="utf-8"))
print("\nObservation state:")
for source in ("tasks", "calendar", "gmail"):
    info = refresh["sources"][source]
    suffix = f"; count={info['count']}" if isinstance(info.get("count"), int) else ""
    print(f"  {source}: {info['state']}{suffix}")
print(f"Visible feed items: {feed['count']}")
PY

printf '\nPhase 4 smoke completed. No outbound delivery or external mutation was performed.\n'

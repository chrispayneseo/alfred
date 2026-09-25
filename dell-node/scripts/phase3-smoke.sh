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

curl_json() {
  local path="$1"
  local output="$2"
  local code
  code="$(curl -sS -o "$output" -w '%{http_code}' \
    -H "X-Alfred-Key: $API_KEY" \
    "$BASE_URL$path")" || fail "Request failed for $path"
  [[ "$code" == "200" ]] || fail "$path returned HTTP $code"
}

health="$TMP_DIR/health.json"
code="$(curl -sS -o "$health" -w '%{http_code}' "$BASE_URL/health")" || fail "Health request failed"
[[ "$code" == "200" ]] || fail "/health returned HTTP $code"
python3 - "$health" <<'PY' || fail "Core health payload is not the expected authoritative Core"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
assert obj.get("status") == "ok"
core = obj.get("core") or {}
assert core.get("orchestrator") == "authoritative"
assert core.get("executor") == "policy_gated"
assert core.get("verification") == "enabled"
assert core.get("approval_resume") == "exact_scope_idempotent"
assert core.get("whatsapp_core_bridge") == "reviewed_suggestions_only"
PY
pass "Core health and authoritative orchestration"

status="$TMP_DIR/status.json"
curl_json "/v1/core/status" "$status"
python3 - "$status" <<'PY' || fail "Core status payload is invalid"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
assert obj.get("status") == "ok"
assert isinstance(obj.get("lifecycle"), dict)
assert isinstance(obj.get("providers"), list)
PY
pass "Authenticated Core status"

capabilities="$TMP_DIR/capabilities.json"
curl_json "/v1/core/capabilities" "$capabilities"
python3 - "$capabilities" "$API_KEY" <<'PY' || fail "Phase 3 capability payload failed safety checks"
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
secret = sys.argv[2]
assert obj.get("phase") == 3
items = obj.get("integrations")
assert isinstance(items, list)
ids = {item.get("id") for item in items}
required = {"alfred_tasks", "home_assistant", "local_files", "google_calendar", "gmail"}
assert required <= ids

actions = {
    capability.get("action")
    for item in items
    for capability in item.get("capabilities", [])
}
for forbidden in (
    "email.send", "email.reply", "email.forward", "email.delete",
    "files.write", "files.delete", "browser.purchase", "browser.book",
):
    assert forbidden not in actions

encoded = json.dumps(obj)
assert secret not in encoded
assert "scope_hash" not in encoded
assert '"arguments"' not in encoded

approvals = obj.get("approvals") or {}
assert isinstance(approvals.get("pending_count"), int)
assert isinstance(approvals.get("items"), list)
PY
pass "Phase 3 capability registry and non-disclosure"

python3 - "$capabilities" <<'PY'
import json, sys
obj = json.load(open(sys.argv[1], encoding="utf-8"))
print("\nIntegration state:")
for item in obj["integrations"]:
    enabled = item.get("enabled_capabilities", 0)
    total = item.get("total_capabilities", 0)
    print(f"  {item['name']}: {item['state']} ({enabled}/{total} capabilities enabled)")
print(f"Pending approvals: {obj['approvals']['pending_count']}")
PY

printf '\nPhase 3 smoke test completed with no mutations performed.\n'

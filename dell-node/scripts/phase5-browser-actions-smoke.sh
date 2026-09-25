#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

sudo docker compose exec -T core python - <<'PY'
from app import browser_actions, execution, integration_adapters, integrations, proactive
from app.core import TOOLS, decide, tool_registry

state = browser_actions.status()
registry = integrations.get_integration("controlled_browser")
paths = {route.path for route in proactive.router.routes}
tools = {item["name"]: item for item in tool_registry()}

expected = {
    "browser.session.open", "browser.navigate", "browser.page.inspect",
    "browser.form.prepare", "browser.submit", "browser.session.close",
}
assert state.get("mode") == "controlled_browser_v1"
assert state.get("navigation") == "public_http_https_only"
assert state.get("private_network_access") is False
assert state.get("untrusted_page_content") is True
assert state.get("form_prepare_network") == "offline"
assert state.get("credential_fields") is False
assert state.get("payment_fields") is False
assert state.get("downloads") is False
assert state.get("file_uploads") is False
assert state.get("persistent_profiles") is False
assert state.get("submission_policy") == "exact_scope_owner_approval"
assert state.get("submission_recovery") == "phase5e_reconciliation_on_ambiguity"
assert state.get("cloud_models") is False

assert expected.issubset(set(TOOLS))
assert expected.issubset(integration_adapters.registered_actions())
assert all(tools[action]["integration"] == "controlled_browser" for action in expected)
assert decide("browser.session.open").decision == "auto"
assert decide("browser.navigate").decision == "auto"
assert decide("browser.page.inspect").decision == "auto"
assert decide("browser.form.prepare").decision == "auto"
assert decide("browser.submit").level == "high_impact"
assert decide("browser.submit").decision == "confirm"
assert decide("browser.submit", confirmed=True).decision == "auto"
assert getattr(execution, "_phase5f_browser_guard_enabled", False) is True

assert registry is not None
capabilities = {item["action"]: item for item in registry["capabilities"]}
assert set(capabilities) == expected
assert capabilities["browser.submit"]["requires_write_enable"] is True
assert capabilities["browser.submit"]["sends_off_device"] is True
assert capabilities["browser.form.prepare"]["sends_off_device"] is False
assert "/v1/core/browser/status" in paths

# Browser actions do not create an email send capability as a side effect.
assert "email.send" not in TOOLS
assert "browser.download" not in TOOLS
assert "browser.upload" not in TOOLS

encoded = (str(state) + str(registry)).casefold()
for forbidden in ("browser_worker_token", "authorization", "cookie", "password_value"):
    assert forbidden not in encoded, forbidden

# Deterministic verifiers can validate safe page state and exact submission dispatch
# without running a browser or performing any external action.
page = {
    "ok": True, "session_id": "smoke-session", "url": "https://example.com",
    "title": "Example", "text": "Untrusted", "links": [], "forms": [],
    "controls": [], "state_fingerprint": "a" * 64,
    "untrusted_web_content": True, "network_mode": "read_only",
}
assert integration_adapters.verify("browser.page.inspect", page)["ok"] is True
prepared = {
    "ok": True, "session_id": "smoke-session", "url": "https://example.com",
    "prepared_count": 1, "state_fingerprint": "b" * 64,
    "unsafe_requests": 0, "network_mode": "offline_prepare", "values_exposed": False,
}
assert integration_adapters.verify("browser.form.prepare", prepared)["ok"] is True
submitted = {
    "ok": True, "dispatch_verified": True, "session_id": "smoke-session",
    "target_origin": "https://example.com", "kind": "reservation",
    "idempotency_key": "c" * 64, "unsafe_request_count": 1,
    "unsafe_response_count": 1,
}
assert integration_adapters.verify("browser.submit", submitted)["ok"] is True

print("PASS: Phase 5F controlled browser capability is registered through Alfred Core")
print("PASS: Public navigation is automatic but private/local network destinations are blocked by worker policy")
print("PASS: Form preparation is offline and credential/payment/file fields are outside the capability")
print("PASS: Every browser submission remains high-impact and requires exact-scope owner approval")
print("PASS: Browser submissions inherit Phase 5E verification, idempotency and ambiguous-outcome reconciliation")
print("PASS: Browser content is marked untrusted and no email-send/download/upload capability was introduced")
print()
print("Controlled browser state:")
print(f"  mode: {state.get('mode')}")
print(f"  configured: {str(bool(state.get('configured'))).lower()}")
print(f"  capabilities: {state.get('enabled_capabilities')}/{state.get('total_capabilities')}")
print(f"  navigation: {state.get('navigation')}")
print(f"  private network access: {str(bool(state.get('private_network_access'))).lower()}")
print(f"  form prepare network: {state.get('form_prepare_network')}")
print(f"  submission policy: {state.get('submission_policy')}")
print(f"  submission recovery: {state.get('submission_recovery')}")
print(f"  cloud models: {str(bool(state.get('cloud_models'))).lower()}")
PY

echo
echo "=== BROWSER WORKER POLICY TESTS ==="
sudo docker compose --profile browser run --rm --no-deps browser-worker \
  python -m unittest test_policy.py -v

echo
echo "Phase 5F smoke completed without opening a website, filling a live form, resolving an approval or performing an external mutation."

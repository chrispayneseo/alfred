#!/usr/bin/env bash
set -euo pipefail

cd /opt/alfred-node

echo "=== PHASE 8 SECURE AUTHENTICATED WEB CONTRACT ==="

sudo docker compose exec -T core python - <<'PY'
from app import authenticated_web, phase8_acceptance, proactive, config
from app.db import connection


def counts():
    with connection() as db:
        return {
            table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "core_executions",
                "core_execution_receipts",
                "core_reliability_operations",
                "approvals",
                "agent_goals",
            )
        }

before = counts()
status = phase8_acceptance.acceptance_status()
auth = authenticated_web.status()
after = counts()
paths = {route.path for route in proactive.router.routes}

assert status.get("mode") == "phase8_secure_authenticated_web_acceptance_v1"
assert status.get("accepted") is True, status.get("failed_checks")
assert status.get("check_count") == 10
assert status.get("new_executor") is False
assert status.get("secrets_entered_by_alfred") is False
assert status.get("payment_data_supported") is False
assert status.get("captcha_supported") is False
assert auth.get("profile_bootstrap") == "human_only"
assert auth.get("password_entry_by_alfred") is False
assert auth.get("otp_entry_by_alfred") is False
assert auth.get("payment_card_entry") is False
assert auth.get("captcha_solving") is False
assert auth.get("new_executor") is False
assert config.settings.browser_submit_enabled is False
assert before == after, (before, after)

for path in (
    "/v1/core/authenticated-web/status",
    "/v1/core/authenticated-web/open",
    "/v1/core/phase8/status",
):
    assert path in paths, path

print("PASS: Phase 8 authenticated profile references are opaque Core inputs")
print("PASS: passwords, OTP/2FA, payment-card fields and CAPTCHA answers remain outside Alfred")
print("PASS: authenticated open is read-only and consequential submit remains Phase 5 exact-scope approval")
print("PASS: browser submit kill switch remains disabled")
print("PASS: Phase 8 adds no parallel Core executor")
print("PASS: reading Phase 8 status creates no execution or approval state")
PY

echo
echo "=== PHASE 8 BROWSER WORKER ROUTES ==="
sudo docker compose --profile browser exec -T browser-worker python - <<'PY'
from app.combined import app
from app import auth_profiles

paths = {route.path for route in app.routes}
assert "/v1/profiles" in paths
assert "/v1/session/open-authenticated" in paths
assert auth_profiles.PROFILE_ID_RE.fullmatch("personal")
print("PASS: browser worker exposes authenticated-profile routes on the existing worker")
PY

echo
echo "=== PHASE 8 ADVERSARIAL ACCEPTANCE ==="
sudo docker compose run --rm --no-deps \
  -v /opt/alfred-node/core/test_phase8_authenticated_web.py:/app/test_phase8_authenticated_web.py:ro \
  -v /opt/alfred-node/core/test_phase8_acceptance.py:/app/test_phase8_acceptance.py:ro \
  core python -m unittest test_phase8_authenticated_web test_phase8_acceptance -v

sudo docker compose --profile browser run --rm --no-deps \
  -v /opt/alfred-node/browser-worker/test_auth_profiles.py:/app/test_auth_profiles.py:ro \
  browser-worker python -m unittest test_auth_profiles.py -v

echo
echo "Phase 8 acceptance completed without entering a password, OTP, card value or CAPTCHA response."
echo "No live browser submission was performed by this smoke."

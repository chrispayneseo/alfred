from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app import authenticated_web, core, execution


class Phase8AuthenticatedWebTests(unittest.IsolatedAsyncioTestCase):
    def test_profile_argument_validation_rejects_secret_shaped_and_extra_fields(self):
        clean = authenticated_web.validate_arguments({"profile_id": "personal", "url": "https://example.com/account"})
        self.assertEqual(clean["profile_id"], "personal")
        with self.assertRaises(ValueError):
            authenticated_web.validate_arguments({"profile_id": "../secret", "url": "https://example.com"})
        with self.assertRaises(ValueError):
            authenticated_web.validate_arguments({
                "profile_id": "personal",
                "url": "https://user:pass@example.com",
            })
        with self.assertRaises(ValueError):
            authenticated_web.validate_arguments({
                "profile_id": "personal",
                "url": "https://example.com",
                "password": "never",
            })

    def test_install_registers_read_only_action_on_existing_executor(self):
        self.assertIn(authenticated_web.AUTH_OPEN_ACTION, core.TOOLS)
        self.assertIn(authenticated_web.AUTH_OPEN_ACTION, authenticated_web.browser_client.BROWSER_ACTIONS)
        decision = execution.decide(authenticated_web.AUTH_OPEN_ACTION)
        self.assertEqual(decision.level, "read")
        self.assertEqual(decision.decision, "auto")
        self.assertTrue(getattr(execution, "_phase8_authenticated_web_enabled", False))

    def test_verification_requires_no_credential_exposure(self):
        base = {
            "ok": True,
            "session_id": "session-12345678",
            "authenticated_profile": "personal",
            "url": "https://example.com/account",
            "state_fingerprint": "a" * 64,
            "credential_values_exposed": False,
            "profile_scope": "origin_allowlist",
            "untrusted_web_content": True,
            "network_mode": "read_only",
        }
        self.assertTrue(authenticated_web._verify_open(base)["ok"])
        exposed = dict(base)
        exposed["credential_values_exposed"] = True
        self.assertFalse(authenticated_web._verify_open(exposed)["ok"])

    async def test_open_adapter_sends_only_profile_id_and_url(self):
        response = {
            "ok": True,
            "session_id": "session-12345678",
            "authenticated_profile": "personal",
            "url": "https://example.com/account",
            "state_fingerprint": "b" * 64,
            "credential_values_exposed": False,
            "profile_scope": "origin_allowlist",
            "untrusted_web_content": True,
            "network_mode": "read_only",
        }
        with patch.object(authenticated_web.browser_client, "_request", new=AsyncMock(return_value=response)) as request:
            result = await authenticated_web._open(
                {"profile_id": "personal", "url": "https://example.com/account"}, "req-1"
            )
        self.assertEqual(result["authenticated_profile"], "personal")
        request.assert_awaited_once_with(
            "POST", "/v1/session/open-authenticated",
            payload={"profile_id": "personal", "url": "https://example.com/account"},
        )

    async def test_status_does_not_expose_profile_secret_values(self):
        with patch.object(
            authenticated_web,
            "_worker_profiles",
            new=AsyncMock(return_value={
                "profiles": [{"id": "personal", "label": "Personal", "allowed_origins": ["https://example.com"]}],
                "secret_values_exposed": False,
            }),
        ):
            payload = await authenticated_web.authenticated_web_status()
        self.assertEqual(payload["profile_count"], 1)
        serialised = repr(payload).casefold()
        self.assertNotIn("password", serialised.replace("password_entry_by_alfred", ""))
        self.assertNotIn("cookie", serialised)
        self.assertNotIn("localstorage", serialised)


if __name__ == "__main__":
    unittest.main()

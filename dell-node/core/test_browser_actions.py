import asyncio
import unittest
from dataclasses import replace
from unittest.mock import AsyncMock, patch

from app import browser_actions, browser_client, config, execution, integration_adapters, integrations, proactive
from app.core import TOOLS, decide, tool_registry


class BrowserActionTests(unittest.TestCase):
    def test_browser_tools_are_static_registered_capabilities(self):
        expected = {
            "browser.session.open", "browser.navigate", "browser.page.inspect",
            "browser.form.prepare", "browser.submit", "browser.session.close",
        }
        self.assertTrue(expected.issubset(set(TOOLS)))
        self.assertTrue(expected.issubset(integration_adapters.registered_actions()))
        owners = {item["name"]: item["integration"] for item in tool_registry()}
        self.assertTrue(all(owners[action] == "controlled_browser" for action in expected))
        self.assertNotIn("email.send", TOOLS)

    def test_policy_keeps_submission_behind_exact_owner_confirmation(self):
        self.assertEqual(decide("browser.session.open").decision, "auto")
        self.assertEqual(decide("browser.navigate").decision, "auto")
        self.assertEqual(decide("browser.page.inspect").decision, "auto")
        self.assertEqual(decide("browser.form.prepare").decision, "auto")
        self.assertEqual(decide("browser.submit").level, "high_impact")
        self.assertEqual(decide("browser.submit").decision, "confirm")
        self.assertEqual(decide("browser.submit", confirmed=True).decision, "auto")
        self.assertTrue(getattr(execution, "_phase5f_browser_guard_enabled", False))

    def test_browser_configuration_and_submit_gate_are_separate(self):
        secret = "worker-secret-never-exposed"
        patched = replace(
            config.settings,
            browser_enabled=True,
            browser_submit_enabled=False,
            browser_worker_url="http://browser-worker:8090",
            browser_worker_token=secret,
        )
        with patch.object(config, "settings", patched):
            browser = integrations.get_integration("controlled_browser")
            read_available, _ = integrations.action_available("browser.page.inspect")
            submit_available, reason = integrations.action_available("browser.submit")
            state = browser_actions.status()
        self.assertTrue(browser["configured"])
        self.assertTrue(read_available)
        self.assertFalse(submit_available)
        self.assertIn("write capability is disabled", reason)
        self.assertNotIn(secret, str(browser))
        self.assertNotIn(secret, str(state))

    def test_submit_gate_enables_capability_but_not_auto_approval(self):
        patched = replace(
            config.settings,
            browser_enabled=True,
            browser_submit_enabled=True,
            browser_worker_url="http://browser-worker:8090",
            browser_worker_token="secret",
        )
        with patch.object(config, "settings", patched):
            available, _ = integrations.action_available("browser.submit")
        self.assertTrue(available)
        self.assertEqual(decide("browser.submit").decision, "confirm")

    def test_sensitive_and_unbounded_form_arguments_fail_preflight_validation(self):
        base = {"session_id": "session-12345678"}
        for selector in ("input[type=password]", "#cvv", "input[name=card-number]", "#otp_code"):
            with self.assertRaises(ValueError):
                browser_client.validate_arguments(
                    "browser.form.prepare",
                    {**base, "fields": [{"selector": selector, "value": "redacted"}]},
                )
        with self.assertRaises(ValueError):
            browser_client.validate_arguments(
                "browser.form.prepare",
                {**base, "fields": [{"selector": "#name", "value": "x" * 1001}]},
            )

    def test_submit_arguments_bind_state_origin_selector_and_kind(self):
        arguments = {
            "session_id": "session-12345678",
            "selector": "button[type=submit]",
            "state_fingerprint": "a" * 64,
            "target_origin": "https://example.com",
            "kind": "reservation",
        }
        browser_client.validate_arguments("browser.submit", arguments)
        key1 = browser_client._submit_key("request-1", arguments)
        key2 = browser_client._submit_key("request-1", arguments)
        changed = dict(arguments, state_fingerprint="b" * 64)
        key3 = browser_client._submit_key("request-1", changed)
        self.assertEqual(key1, key2)
        self.assertNotEqual(key1, key3)

    def test_browser_adapters_verify_untrusted_page_and_submission_dispatch(self):
        page = {
            "ok": True, "session_id": "session-1", "url": "https://example.com",
            "title": "Example", "text": "Untrusted", "links": [], "forms": [],
            "controls": [], "state_fingerprint": "a" * 64,
            "untrusted_web_content": True, "network_mode": "read_only",
        }
        verified = integration_adapters.verify("browser.page.inspect", page)
        self.assertTrue(verified["ok"])
        self.assertTrue(verified["untrusted_web_content"])

        submission = {
            "ok": True, "dispatch_verified": True, "session_id": "session-1",
            "target_origin": "https://example.com", "kind": "purchase",
            "idempotency_key": "b" * 64, "unsafe_request_count": 1,
            "unsafe_response_count": 1,
        }
        verified_submit = integration_adapters.verify("browser.submit", submission)
        self.assertTrue(verified_submit["ok"])
        self.assertEqual(verified_submit["method"], "browser_submission_dispatch")

    def test_adapter_calls_worker_without_exposing_token_in_result(self):
        patched = replace(
            config.settings,
            browser_enabled=True,
            browser_worker_url="http://browser-worker:8090",
            browser_worker_token="top-secret-token",
        )
        worker_result = {
            "ok": True, "session_id": "session-1", "url": "https://example.com",
            "title": "Example", "text": "Page", "links": [], "forms": [],
            "controls": [], "state_fingerprint": "c" * 64,
            "untrusted_web_content": True, "network_mode": "read_only",
        }
        with (
            patch.object(config, "settings", patched),
            patch.object(browser_client, "_request", new=AsyncMock(return_value=worker_result)),
        ):
            result = asyncio.run(integration_adapters.invoke(
                "browser.session.open", {"url": "https://example.com"}, "req-browser"
            ))
        self.assertEqual(result, worker_result)
        self.assertNotIn("top-secret-token", str(result))

    def test_browser_status_route_uses_existing_authenticated_core_collection(self):
        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/browser/status", paths)
        state = browser_actions.status()
        encoded = str(state).casefold()
        for forbidden in ("token", "password", "cookie", "authorization"):
            self.assertNotIn(forbidden, encoded)
        self.assertEqual(state["submission_policy"], "exact_scope_owner_approval")
        self.assertFalse(state["private_network_access"])
        self.assertFalse(state["credential_fields"])
        self.assertFalse(state["payment_fields"])


if __name__ == "__main__":
    unittest.main()

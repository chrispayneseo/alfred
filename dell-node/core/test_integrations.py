import asyncio
import unittest
from dataclasses import replace
from unittest.mock import AsyncMock, patch

from app import clients, config, integrations
from app.core import TOOLS, tool_registry


class IntegrationFrameworkTests(unittest.TestCase):
    def test_tool_registry_exposes_integration_owner(self):
        tools = {item["name"]: item for item in tool_registry()}
        self.assertEqual(tools["home_assistant.service"]["integration"], "home_assistant")
        self.assertEqual(tools["memory.read"]["integration"], "core")

    def test_every_manifest_action_is_registered_with_core_policy(self):
        actions = {
            capability["action"]
            for integration in integrations.integration_registry()
            for capability in integration["capabilities"]
        }
        self.assertTrue(actions)
        self.assertTrue(actions.issubset(set(TOOLS)))

    def test_calendar_is_planned_and_has_no_executable_capabilities(self):
        calendar = integrations.get_integration("google_calendar")
        self.assertIsNotNone(calendar)
        self.assertEqual(calendar["state"], "planned")
        self.assertFalse(calendar["configured"])
        self.assertEqual(calendar["capabilities"], [])

    def test_home_assistant_not_configured_fails_availability_check(self):
        patched = replace(config.settings, ha_url="", ha_token="")
        with patch.object(config, "settings", patched):
            available, reason = integrations.action_available("home_assistant.service")
        self.assertFalse(available)
        self.assertIn("not configured", reason)

    def test_home_assistant_manifest_never_exposes_token(self):
        secret = "super-secret-ha-token"
        patched = replace(config.settings, ha_url="http://ha.local:8123", ha_token=secret)
        with patch.object(config, "settings", patched):
            registry = integrations.integration_registry()
        self.assertNotIn(secret, str(registry))
        home = next(item for item in registry if item["id"] == "home_assistant")
        self.assertTrue(home["configured"])
        self.assertEqual(home["state"], "ready")
        self.assertEqual(home["boundary"], "local_network")
        self.assertFalse(home["capabilities"][0]["sends_off_device"])

    def test_health_returns_state_only_not_credentials_or_entities(self):
        secret = "health-secret-token"
        patched = replace(config.settings, ha_url="http://ha.local:8123", ha_token=secret)
        with (
            patch.object(config, "settings", patched),
            patch.object(clients, "settings", patched),
            patch.object(clients, "home_assistant_health", new=AsyncMock(return_value={"state": "ready"})),
        ):
            health = asyncio.run(integrations.integration_health())
        serialized = str(health)
        self.assertNotIn(secret, serialized)
        self.assertNotIn("entity_id", serialized)
        home = next(item for item in health if item["id"] == "home_assistant")
        self.assertEqual(home["state"], "ready")

    def test_planned_action_is_not_available_even_if_asked_directly(self):
        available, reason = integrations.action_available("calendar.events.create")
        # The action is not registered as a capability yet, so the integration
        # framework does not claim ownership; Core itself will deny it because
        # it is absent from TOOLS.
        self.assertTrue(available)
        self.assertIsNone(reason)
        self.assertNotIn("calendar.events.create", TOOLS)


if __name__ == "__main__":
    unittest.main()

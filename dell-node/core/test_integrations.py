import asyncio
import unittest
from dataclasses import replace
from unittest.mock import AsyncMock, patch

from app import clients, config, integration_adapters, integrations
from app.core import TOOLS, tool_registry


class IntegrationFrameworkTests(unittest.TestCase):
    def test_tool_registry_exposes_integration_owner(self):
        tools = {item["name"]: item for item in tool_registry()}
        self.assertEqual(tools["tasks.list"]["integration"], "alfred_tasks")
        self.assertEqual(tools["home_assistant.service"]["integration"], "home_assistant")
        self.assertEqual(tools["calendar.events.list"]["integration"], "google_calendar")
        self.assertEqual(tools["calendar.events.create"]["integration"], "google_calendar")
        self.assertEqual(tools["memory.read"]["integration"], "core")

    def test_every_manifest_action_has_policy_and_exactly_one_adapter(self):
        actions = {capability["action"] for integration in integrations.integration_registry() for capability in integration["capabilities"]}
        self.assertTrue(actions)
        self.assertTrue(actions.issubset(set(TOOLS)))
        self.assertEqual(actions, integration_adapters.registered_actions())
        self.assertNotIn("memory.read", integration_adapters.registered_actions())

    def test_unknown_adapter_action_returns_none(self):
        result = asyncio.run(integration_adapters.invoke("unknown.integration.action", {}, "req-unknown"))
        self.assertIsNone(result)
        self.assertIsNone(integration_adapters.verify("unknown.integration.action", {}))

    def test_calendar_reads_enabled_but_writes_disabled_by_default(self):
        patched = replace(
            config.settings,
            google_client_id="client",
            google_client_secret="secret",
            google_refresh_token="refresh",
            google_calendar_id="primary",
            google_calendar_write_enabled=False,
        )
        with patch.object(config, "settings", patched):
            calendar = integrations.get_integration("google_calendar")
            read_available, _ = integrations.action_available("calendar.events.list")
            write_available, reason = integrations.action_available("calendar.events.create")
        capabilities = {item["action"]: item for item in calendar["capabilities"]}
        self.assertTrue(read_available)
        self.assertTrue(capabilities["calendar.events.list"]["enabled"])
        self.assertFalse(write_available)
        self.assertFalse(capabilities["calendar.events.create"]["enabled"])
        self.assertIn("write capability is disabled", reason)

    def test_calendar_write_gate_enables_mutations_without_exposing_credentials(self):
        secrets = ("client-secret-id", "client-secret-value", "refresh-secret-value")
        patched = replace(
            config.settings,
            google_client_id=secrets[0],
            google_client_secret=secrets[1],
            google_refresh_token=secrets[2],
            google_calendar_id="primary",
            google_calendar_write_enabled=True,
        )
        with patch.object(config, "settings", patched):
            calendar = integrations.get_integration("google_calendar")
            available = {action: integrations.action_available(action)[0] for action in (
                "calendar.events.create", "calendar.events.update", "calendar.events.delete"
            )}
        self.assertTrue(all(available.values()))
        self.assertTrue(calendar["configured"])
        serialized = str(calendar)
        for secret in secrets:
            self.assertNotIn(secret, serialized)

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
        tasks = next(item for item in health if item["id"] == "alfred_tasks")
        self.assertEqual(tasks["state"], "ready")
        home = next(item for item in health if item["id"] == "home_assistant")
        self.assertEqual(home["state"], "ready")


if __name__ == "__main__":
    unittest.main()

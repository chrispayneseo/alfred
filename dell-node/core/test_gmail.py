import asyncio
import base64
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import config, db, execution, gmail, integration_adapters, integrations
from app.core import TOOLS, decide


class GmailIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.execution_connection_patch = patch.object(execution, "connection", db.connection)
        self.db_patch.start()
        self.execution_connection_patch.start()
        db.initialise()
        execution.initialise_execution_store()

    def tearDown(self):
        self.execution_connection_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    def _configured(self):
        return replace(
            config.settings,
            gmail_client_id="gmail-client-id",
            gmail_client_secret="gmail-client-secret",
            gmail_refresh_token="gmail-refresh-token",
            gmail_user_id="me",
        )

    def test_gmail_reads_stay_read_only_and_mutations_are_separately_gated(self):
        configured = self._configured()
        with patch.object(config, "settings", configured):
            integration = integrations.get_integration("gmail")
            draft_available, draft_reason = integrations.action_available("email.draft.create")
            send_available, send_reason = integrations.action_available("email.draft.send")
        self.assertTrue(integration["configured"])
        self.assertEqual(integration["state"], "ready")
        capabilities = {item["action"]: item for item in integration["capabilities"]}
        self.assertEqual(
            set(capabilities),
            {"email.messages.search", "email.message.get", "email.draft.create", "email.draft.send"},
        )
        self.assertEqual(capabilities["email.messages.search"]["mode"], "read")
        self.assertEqual(capabilities["email.message.get"]["mode"], "read")
        self.assertTrue(capabilities["email.messages.search"]["enabled"])
        self.assertTrue(capabilities["email.message.get"]["enabled"])
        self.assertEqual(capabilities["email.draft.create"]["mode"], "write")
        self.assertEqual(capabilities["email.draft.send"]["mode"], "action")
        self.assertFalse(capabilities["email.draft.create"]["enabled"])
        self.assertFalse(capabilities["email.draft.send"]["enabled"])
        self.assertFalse(draft_available)
        self.assertFalse(send_available)
        self.assertIn("write capability is disabled", draft_reason)
        self.assertIn("write capability is disabled", send_reason)
        self.assertEqual(decide("email.draft.create").decision, "confirm")
        self.assertEqual(decide("email.draft.create").level, "external")
        self.assertEqual(decide("email.draft.send").decision, "confirm")
        self.assertEqual(decide("email.draft.send").level, "high_impact")
        self.assertIn("email.draft.create", TOOLS)
        self.assertIn("email.draft.send", TOOLS)
        self.assertIn("email.draft.create", integration_adapters.registered_actions())
        self.assertIn("email.draft.send", integration_adapters.registered_actions())
        for action in ("email.send", "email.archive", "email.delete", "email.labels.modify"):
            self.assertNotIn(action, TOOLS)
            self.assertNotIn(action, integration_adapters.registered_actions())

    def test_registry_never_exposes_gmail_credentials(self):
        configured = replace(
            self._configured(),
            gmail_write_client_id="gmail-write-client-id",
            gmail_write_client_secret="gmail-write-client-secret",
            gmail_write_refresh_token="gmail-write-refresh-token",
            gmail_write_enabled=True,
            gmail_send_enabled=True,
        )
        with patch.object(config, "settings", configured):
            registry = integrations.integration_registry()
        serialized = str(registry)
        for secret in (
            "gmail-client-secret",
            "gmail-refresh-token",
            "gmail-client-id",
            "gmail-write-client-id",
            "gmail-write-client-secret",
            "gmail-write-refresh-token",
        ):
            self.assertNotIn(secret, serialized)

    def test_unconfigured_gmail_fails_closed_without_execution_side_effect(self):
        unconfigured = replace(
            config.settings,
            gmail_client_id="",
            gmail_client_secret="",
            gmail_refresh_token="",
        )
        with patch.object(config, "settings", unconfigured):
            result = asyncio.run(execution.execute_tool(
                request_id="req-gmail-off",
                action="email.messages.search",
                arguments={"query": "is:unread", "limit": 5},
            ))
        self.assertEqual(result["state"], "denied")
        self.assertIn("not configured", result["error"])
        with db.connection() as connection:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE request_id = ?", ("req-gmail-off",)
            ).fetchone()[0], 0)

    def test_search_is_automatic_read_and_verified(self):
        configured = self._configured()
        payload = {
            "ok": True,
            "messages": [{
                "id": "18fabc123",
                "thread_id": "18fabc100",
                "from": "Example <sender@example.com>",
                "to": "me@example.com",
                "subject": "Invoice",
                "date": "Fri, 25 Sep 2026 08:00:00 +0100",
                "snippet": "Your invoice is ready",
                "unread": True,
            }],
            "count": 1,
        }
        with (
            patch.object(config, "settings", configured),
            patch.object(integration_adapters, "gmail_search_messages", new=AsyncMock(return_value=payload)),
        ):
            result = asyncio.run(execution.execute_tool(
                request_id="req-gmail-search",
                action="email.messages.search",
                arguments={"query": "subject:invoice newer_than:7d", "limit": 5},
            ))
        self.assertEqual(result["state"], "completed")
        self.assertIsNone(result["approval"])
        self.assertTrue(result["verification"]["ok"])
        self.assertEqual(result["verification"]["method"], "email_search")
        self.assertEqual(result["verification"]["message_count"], 1)

    def test_single_message_read_is_bounded_and_verified(self):
        configured = self._configured()
        payload = {
            "ok": True,
            "message": {
                "id": "18fabc123",
                "thread_id": "18fabc100",
                "from": "Example <sender@example.com>",
                "to": "me@example.com",
                "subject": "Invoice",
                "date": "Fri, 25 Sep 2026 08:00:00 +0100",
                "snippet": "Your invoice is ready",
                "unread": False,
                "body": "Attached is the invoice summary.",
            },
        }
        with (
            patch.object(config, "settings", configured),
            patch.object(integration_adapters, "gmail_get_message", new=AsyncMock(return_value=payload)),
        ):
            result = asyncio.run(execution.execute_tool(
                request_id="req-gmail-get",
                action="email.message.get",
                arguments={"message_id": "18fabc123"},
            ))
        self.assertEqual(result["state"], "completed")
        self.assertTrue(result["verification"]["ok"])
        self.assertEqual(result["verification"]["method"], "email_message")

    def test_query_message_id_and_body_are_bounded(self):
        with self.assertRaisesRegex(ValueError, "500"):
            gmail._clean_query("x" * 501)
        with self.assertRaisesRegex(ValueError, "Invalid Gmail message id"):
            gmail._message_id("bad/id")
        encoded = base64.urlsafe_b64encode(("a" * (gmail.MAX_BODY_CHARS + 500)).encode()).decode().rstrip("=")
        self.assertEqual(len(gmail._decode_body(encoded)), gmail.MAX_BODY_CHARS)


if __name__ == "__main__":
    unittest.main()

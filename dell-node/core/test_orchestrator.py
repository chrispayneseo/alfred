import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import db, inbox_api
from app.orchestrator import orchestrate
from app.providers import provider_registry


class OrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.core_path = str(base / "core.sqlite3")
        self.patch_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.core_path))
        self.patch_inbox_path = patch.object(inbox_api, "INBOX_DB", str(base / "inbox.sqlite3"))
        self.patch_settings.start()
        self.patch_inbox_path.start()
        db.initialise()
        inbox_api.initialise()

    def tearDown(self):
        self.patch_inbox_path.stop()
        self.patch_settings.stop()
        self.temp.cleanup()

    def test_saved_personal_information_stays_local_without_cloud_routing(self):
        db.remember("note", "The spare key is in the blue drawer", "test")
        recall_answerer = AsyncMock(return_value="It is in the blue drawer.")
        with patch("app.orchestrator.ollama_route", new=AsyncMock(side_effect=AssertionError("router should not be called"))):
            result = asyncio.run(orchestrate(
                channel="web",
                message="Where is the spare key?",
                recall_answerer=recall_answerer,
            ))
        self.assertEqual(result["decision"], "local")
        self.assertEqual(result["reply"], "It is in the blue drawer.")
        self.assertEqual(result["memory_sent"], False)
        self.assertEqual(len(result["sources"]), 1)
        self.assertTrue(result["request_id"])
        self.assertTrue(result["conversation_id"])

    def test_private_cloud_request_requires_approval_and_sends_no_memory(self):
        result = asyncio.run(orchestrate(
            channel="web",
            message="Research my boiler warranty online",
        ))
        self.assertEqual(result["decision"], "approval_required")
        self.assertEqual(result["cloud_prompt"], "Research my boiler warranty online")
        self.assertFalse(result["memory_sent"])

    def test_connected_account_request_fails_closed_until_connector_exists(self):
        result = asyncio.run(orchestrate(
            channel="whatsapp",
            message="What's on my calendar tomorrow?",
            conversation_id="wa-123",
        ))
        self.assertEqual(result["decision"], "connection_needed")
        self.assertEqual(result["conversation_id"], "wa-123")

    def test_non_private_cloud_request_is_prepared_but_not_executed(self):
        result = asyncio.run(orchestrate(
            channel="api",
            message="Research the latest Python packaging standards",
        ))
        self.assertEqual(result["decision"], "cloud_ready")
        self.assertEqual(result["provider"], "openai")
        self.assertEqual(result["cloud_prompt"], "Research the latest Python packaging standards")
        self.assertFalse(result["memory_sent"])

    def test_local_chat_uses_local_provider(self):
        with patch("app.orchestrator.ollama_chat", new=AsyncMock(return_value="Hello from Alfred.")):
            result = asyncio.run(orchestrate(channel="voice", message="Hello Alfred"))
        self.assertEqual(result["decision"], "local")
        self.assertEqual(result["provider"], "ollama.chat")
        self.assertEqual(result["reply"], "Hello from Alfred.")

    def test_provider_registry_declares_off_device_boundary(self):
        providers = {item["name"]: item for item in provider_registry()}
        self.assertFalse(providers["ollama.chat"]["sends_off_device"])
        self.assertTrue(providers["openai"]["sends_off_device"])
        self.assertFalse(providers["openai"]["enabled"])


if __name__ == "__main__":
    unittest.main()

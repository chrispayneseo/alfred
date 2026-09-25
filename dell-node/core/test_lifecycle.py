import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import db, lifecycle, orchestrator


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.patch_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.patch_settings.start()
        db.initialise()
        lifecycle.initialise_request_store()

    def tearDown(self):
        self.patch_settings.stop()
        self.temp.cleanup()

    def test_lifecycle_metadata_does_not_store_raw_message(self):
        request = {
            "request_id": "req-private",
            "conversation_id": "conversation-1",
            "channel": "web",
            "message": "A deliberately private sentence",
        }
        lifecycle.begin_request(request)
        stored = lifecycle.get_request("req-private")
        self.assertIsNotNone(stored)
        self.assertNotIn("message", stored)
        self.assertEqual(stored["message_length"], len(request["message"]))
        self.assertEqual(len(stored["message_sha256"]), 64)
        self.assertNotIn(request["message"], str(stored))

    def test_local_orchestration_reaches_completed_state(self):
        with patch.object(orchestrator, "ollama_chat", new=AsyncMock(return_value="Hello.")):
            result = asyncio.run(orchestrator.orchestrate(channel="web", message="Hello Alfred"))
        stored = lifecycle.get_request(result["request_id"])
        self.assertEqual(result["decision"], "local")
        self.assertEqual(stored["state"], "completed")
        self.assertEqual(stored["route"], "local")
        self.assertEqual(stored["provider"], "ollama.chat")
        timeline = lifecycle.request_timeline(result["request_id"])
        self.assertIn("request.received", [item["event_type"] for item in timeline])
        self.assertIn("request.routed", [item["event_type"] for item in timeline])

    def test_private_cloud_request_waits_for_approval(self):
        result = asyncio.run(orchestrator.orchestrate(
            channel="web", message="Research my boiler warranty online"
        ))
        stored = lifecycle.get_request(result["request_id"])
        self.assertEqual(result["decision"], "approval_required")
        self.assertEqual(stored["state"], "awaiting_approval")
        self.assertEqual(stored["route"], "approval_required")

    def test_connected_request_records_connection_needed(self):
        result = asyncio.run(orchestrator.orchestrate(
            channel="web", message="Check my calendar tomorrow"
        ))
        stored = lifecycle.get_request(result["request_id"])
        self.assertEqual(result["decision"], "connection_needed")
        self.assertEqual(stored["state"], "connection_needed")

    def test_tool_planning_is_a_valid_nonterminal_state(self):
        request = {
            "request_id": "req-tool-plan",
            "conversation_id": "req-tool-plan",
            "channel": "api",
            "message": "What's on my calendar tomorrow?",
        }
        lifecycle.begin_request(request)
        updated = lifecycle.transition_request(
            "req-tool-plan",
            "tool_planning",
            route="tool",
            provider="integration:google_calendar",
        )
        self.assertEqual(updated["state"], "tool_planning")
        self.assertEqual(updated["route"], "tool")
        self.assertEqual(updated["provider"], "integration:google_calendar")
        self.assertNotIn("tool_planning", lifecycle.TERMINAL_STATES)

    def test_model_failure_is_recorded_without_error_text(self):
        with patch.object(orchestrator, "ollama_chat", new=AsyncMock(side_effect=RuntimeError("secret failure detail"))):
            with self.assertRaises(RuntimeError):
                asyncio.run(orchestrator.orchestrate(channel="web", message="Tell me something"))
        items = lifecycle.list_requests(limit=1)
        self.assertEqual(items[0]["state"], "failed")
        self.assertEqual(items[0]["error_type"], "RuntimeError")
        self.assertNotIn("secret failure detail", str(items[0]))

    def test_status_summary_counts_pending_work(self):
        request = {
            "request_id": "req-summary",
            "conversation_id": "req-summary",
            "channel": "api",
            "message": "status",
        }
        lifecycle.begin_request(request)
        lifecycle.transition_request("req-summary", "awaiting_approval", route="approval_required")
        db.create_approval("req-summary", None, "memory.write", "Save note", "safe_write")
        summary = lifecycle.lifecycle_summary()
        self.assertEqual(summary["requests"]["awaiting_approval"], 1)
        self.assertEqual(summary["pending_approvals"], 1)


if __name__ == "__main__":
    unittest.main()

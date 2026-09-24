import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from app import candidate_extractor, db, inbox_api, memory_service, orchestrator


class CandidateExtractorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.core_path = str(base / "core.sqlite3")
        self.patch_db = patch.object(db, "settings", replace(db.settings, sqlite_path=self.core_path))
        self.patch_inbox = patch.object(inbox_api, "INBOX_DB", str(base / "inbox.sqlite3"))
        self.patch_db.start()
        self.patch_inbox.start()
        db.initialise()
        inbox_api.initialise()

    def tearDown(self):
        self.patch_inbox.stop()
        self.patch_db.stop()
        self.temp.cleanup()

    def test_stable_statement_patterns_are_grounded_in_user_wording(self):
        items = candidate_extractor.extract(
            "I prefer dark mode. I work as an SEO specialist. I'm building Alfred"
        )
        self.assertEqual([item["memory_type"] for item in items], [
            "preference", "identity", "project"
        ])
        self.assertEqual(items[0]["content"], "I prefer dark mode")
        self.assertEqual(items[1]["content"], "I work as an SEO specialist")
        self.assertEqual(items[2]["content"], "I'm building Alfred")

    def test_transient_questions_and_secrets_are_not_candidates(self):
        messages = [
            "I prefer tea today",
            "I have a meeting tomorrow",
            "Do I prefer dark mode?",
            "My password is swordfish",
            "My recovery code is 123456",
            "My card number is 4111111111111111",
        ]
        for message in messages:
            self.assertEqual(candidate_extractor.extract(message), [], message)

    def test_local_conversation_creates_review_candidate_not_memory(self):
        fake_chat = AsyncMock(return_value="Noted in the conversation.")
        with patch.object(orchestrator, "ollama_chat", new=fake_chat):
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="I prefer dark mode",
                conversation_id="conv-candidate",
            ))

        self.assertEqual(result["decision"], "local")
        candidates = memory_service.list_memory_candidates()
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["content"], "I prefer dark mode")
        self.assertEqual(candidates[0]["memory_type"], "preference")
        self.assertEqual(candidates[0]["state"], "pending")
        self.assertEqual(db.list_memories(), [])

    def test_repeated_statement_reuses_same_open_candidate(self):
        fake_chat = AsyncMock(return_value="OK")
        with patch.object(orchestrator, "ollama_chat", new=fake_chat):
            asyncio.run(orchestrator.orchestrate(
                channel="api", message="I prefer dark mode", conversation_id="conv-one"
            ))
            asyncio.run(orchestrator.orchestrate(
                channel="api", message="I prefer dark mode", conversation_id="conv-two"
            ))
        self.assertEqual(len(memory_service.list_memory_candidates()), 1)
        self.assertEqual(db.list_memories(), [])

    def test_cloud_routed_prompt_never_runs_candidate_capture(self):
        capture = Mock(return_value=[])
        cloud = AsyncMock(return_value={
            "state": "provider_unavailable",
            "provider": "openai",
            "model": "gpt-test",
            "reason": "Not configured",
            "memory_sent": False,
        })
        with patch.object(orchestrator, "capture_memory_candidates", new=capture), patch.object(
            orchestrator, "execute_cloud_request", new=cloud
        ):
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="Research the current Python release online",
                conversation_id="conv-cloud-candidate",
            ))
        self.assertEqual(result["decision"], "cloud_ready")
        capture.assert_not_called()

    def test_capture_failure_cannot_break_local_response(self):
        fake_chat = AsyncMock(return_value="Safe reply")
        failing_capture = Mock(side_effect=RuntimeError("candidate store unavailable"))
        with patch.object(orchestrator, "ollama_chat", new=fake_chat), patch.object(
            orchestrator, "capture_memory_candidates", new=failing_capture
        ):
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="I prefer dark mode",
                conversation_id="conv-capture-failure",
            ))
        self.assertEqual(result["decision"], "local")
        self.assertEqual(result["reply"], "Safe reply")
        with db.connection() as connection:
            events = connection.execute(
                "SELECT event_type FROM audit_events WHERE request_id = ?",
                (result["request_id"],),
            ).fetchall()
        self.assertIn("memory.candidate_extraction_failed", {row["event_type"] for row in events})


if __name__ == "__main__":
    unittest.main()

import asyncio
import tempfile
import unittest
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from app import (
    conversation_store,
    db,
    inbox_api,
    memory_candidates,
    memory_health,
    memory_service,
)


class Phase2AcceptanceTests(unittest.TestCase):
    """Integrated acceptance tests for Alfred's Phase 2 context-selection boundary."""

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
        conversation_store.initialise()

    def tearDown(self):
        self.patch_inbox.stop()
        self.patch_db.stop()
        self.temp.cleanup()

    def test_user_sourced_memory_beats_low_confidence_model_memory_when_relevance_is_similar(self):
        inferred = memory_service.create_memory(
            "fact", "Boiler service provider is Alpha Heating", "model"
        )
        trusted = memory_service.create_memory(
            "fact", "Boiler service provider is Beta Heating", "user"
        )
        results = memory_service.retrieve_context("boiler service provider heating", 2)
        self.assertEqual(results[0]["id"], f"memory:{trusted['id']}")
        self.assertGreater(results[0]["confidence"], results[1]["confidence"])
        self.assertEqual(results[1]["id"], f"memory:{inferred['id']}")

    def test_newer_equally_relevant_memory_can_beat_stale_context(self):
        stale = memory_service.create_memory(
            "fact", "Garage contractor Alpha Builders handles repairs", "user"
        )
        current = memory_service.create_memory(
            "fact", "Garage contractor Beta Builders handles repairs", "user"
        )
        with db.connection() as connection:
            connection.execute(
                "UPDATE memories SET created_at = datetime('now', '-1200 days') WHERE id = ?",
                (stale["id"],),
            )
        results = memory_service.retrieve_context("garage contractor builders repairs", 2)
        self.assertEqual(results[0]["id"], f"memory:{current['id']}")
        self.assertGreater(results[0]["score_components"]["recency"], results[1]["score_components"]["recency"])

    def test_due_reminder_is_prioritised_over_distant_similar_task(self):
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        distant = (date.today() + timedelta(days=180)).isoformat()
        reminder = inbox_api.ManualFiling(
            source_id="manual:11111111-1111-4111-8111-111111111111",
            kind="reminder",
            title="Renew household insurance",
            detail="Check renewal quote",
            due=tomorrow,
        )
        task = inbox_api.ManualFiling(
            source_id="manual:22222222-2222-4222-8222-222222222222",
            kind="task",
            title="Renew household insurance",
            detail="Compare providers",
            due=distant,
        )
        asyncio.run(inbox_api.create_filed(task))
        asyncio.run(inbox_api.create_filed(reminder))

        results = memory_service.retrieve_context("renew household insurance", 2)
        self.assertEqual(results[0]["kind"], "reminder")
        self.assertGreater(results[0]["score_components"]["due_boost"], 0)

    def test_graph_adds_related_context_without_bypassing_budget(self):
        memory_service.create_memory(
            "fact", "Boiler manual is stored in the blue utility drawer", "user"
        )
        memory_service.create_memory(
            "fact", "Blue utility drawer also contains the warranty certificate", "user"
        )
        pack = memory_service.build_context_pack(
            "where is the boiler manual", limit=5, max_chars=900
        )
        contents = [item["content"] for item in pack["items"]]
        self.assertTrue(any("Boiler manual" in content for content in contents))
        self.assertTrue(any("warranty certificate" in content for content in contents))
        self.assertGreaterEqual(pack.get("graph", {}).get("expanded", 0), 1)
        self.assertLessEqual(pack["budget"]["used_chars"], 900)

    def test_superseded_fact_is_retained_but_never_selected_as_active_context(self):
        old = memory_service.create_memory(
            "preference", "Evie likes wild swimming", "user"
        )
        candidate = memory_service.propose_memory_candidate(
            "Evie dislikes wild swimming", memory_type="preference", source="auto-local"
        )
        promoted = memory_service.promote_memory_candidate(
            candidate["id"], supersede_memory_id=old["id"], request_id="phase2-acceptance"
        )
        self.assertTrue(memory_candidates.is_superseded(old["id"]))
        self.assertIsNotNone(memory_service.get_memory(old["id"]))

        results = memory_service.retrieve_context("Evie wild swimming", 8)
        ids = {item["id"] for item in results}
        self.assertNotIn(f"memory:{old['id']}", ids)
        self.assertIn(f"memory:{promoted['memory']['id']}", ids)

    def test_review_candidate_and_transient_turn_never_appear_as_durable_memory(self):
        candidate = memory_service.propose_memory_candidate(
            "I prefer quiet hotel rooms", memory_type="preference", source="auto-local"
        )
        conversation_store.record_turn(
            "phase2-conversation",
            "user",
            "I prefer a late checkout for this trip",
            request_id="phase2-turn",
        )
        self.assertEqual(candidate["state"], "pending")
        self.assertEqual(db.list_memories(), [])
        self.assertEqual(memory_service.retrieve_context("quiet hotel rooms late checkout", 8), [])

    def test_memory_health_reports_only_metadata_not_memory_content(self):
        memory_service.create_memory("fact", "Spare key is in the green drawer", "user")
        memory_service.propose_memory_candidate(
            "I prefer dark mode", memory_type="preference", source="auto-local"
        )
        conversation_store.record_turn(
            "phase2-health", "user", "Transient secret-free context", request_id="phase2-health-turn"
        )

        health = memory_health.memory_health()
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["durable"]["active"], 1)
        self.assertEqual(health["durable"]["metadata_coverage"], 1.0)
        self.assertEqual(health["candidates"]["open"], 1)
        self.assertEqual(health["context"]["short_term_turns"], 1)
        serialized = str(health)
        self.assertNotIn("Spare key", serialized)
        self.assertNotIn("dark mode", serialized)
        self.assertNotIn("Transient secret-free context", serialized)


if __name__ == "__main__":
    unittest.main()

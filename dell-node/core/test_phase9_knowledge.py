from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, inbox_api, knowledge, memory_service, phase9_acceptance


class Phase9KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.patch_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=str(base / "core.sqlite3")))
        self.patch_inbox = patch.object(inbox_api, "INBOX_DB", str(base / "inbox.sqlite3"))
        self.patch_settings.start()
        self.patch_inbox.start()
        db.initialise()
        inbox_api.initialise()

    def tearDown(self):
        self.patch_inbox.stop()
        self.patch_settings.stop()
        self.temp.cleanup()

    def test_search_preserves_provenance_confidence_and_entities(self):
        item = memory_service.create_memory(
            "preference", "Chris prefers walking near Romsey with Bramble", "user"
        )
        result = knowledge.search("walking Romsey", 5)
        match = next(row for row in result["items"] if row.get("memory_id") == item["id"])
        self.assertEqual(match["provenance"], f"durable_memory:{item['id']}")
        self.assertEqual(match["confidence"], 1.0)
        self.assertIn("Romsey", match["entities"])
        self.assertFalse(result["cloud_models"])
        self.assertFalse(result["connected_payload_indexed"])

    def test_decision_history_only_uses_durable_decision_preference_constraint(self):
        memory_service.create_memory("preference", "Chris prefers light oak furniture", "manual")
        memory_service.create_memory("note", "Random temporary note", "manual")
        history = knowledge.decision_history()
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["memory_type"], "preference")
        self.assertIn("light oak", history[0]["content"])

    def test_superseded_memory_is_not_active_knowledge(self):
        old = memory_service.create_memory("preference", "Chris prefers blue notebooks", "manual")
        new = memory_service.create_memory("preference", "Chris prefers green notebooks", "manual")
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO memory_supersessions(memory_id, superseded_by_memory_id, reason) VALUES (?, ?, 'test')",
                (old["id"], new["id"]),
            )
        result = knowledge.search("notebooks", 10)
        ids = {row.get("memory_id") for row in result["items"]}
        self.assertNotIn(old["id"], ids)
        self.assertIn(new["id"], ids)
        self.assertEqual(knowledge.status()["superseded_memories"], 1)

    def test_conflict_is_review_item_not_silent_replacement(self):
        memory_service.create_memory("preference", "Chris likes quiet hotels near stations", "user")
        candidate = memory_service.propose_memory_candidate(
            "Chris dislikes quiet hotels near stations", memory_type="preference", source="local-context"
        )
        self.assertEqual(candidate["state"], "conflict")
        conflicts = knowledge.contradictions()
        self.assertEqual(conflicts[0]["state"], "owner_review_required")
        self.assertIsNotNone(conflicts[0]["conflict_memory_id"])
        self.assertIn("dislikes", conflicts[0]["candidate_content"])

    def test_entity_index_and_entity_view_use_local_memory_graph(self):
        memory_service.create_memory("person", "Jack studies near Winchester College", "user")
        memory_service.create_memory("fact", "Winchester College is linked to Jack planning", "user")
        entities = {row["entity"] for row in knowledge.entity_index()}
        self.assertIn("Winchester College", entities)
        view = knowledge.entity_view("Winchester College")
        self.assertGreaterEqual(view["claim_count"], 1)


class Phase9AcceptanceTests(unittest.TestCase):
    def test_acceptance_contract_and_fail_closed_baseline(self):
        safe_status = {
            "mode": knowledge.MODE,
            "content_policy": "approved_local_memory_only",
            "provenance_preserved": True,
            "confidence_preserved": True,
            "supersession_preserved": True,
            "contradictions_require_owner_review": True,
            "connected_payload_indexed": False,
            "transient_conversation_indexed": False,
            "model_auto_memory": False,
            "new_executor": False,
            "cloud_models": False,
        }
        with patch.object(phase9_acceptance.knowledge, "status", return_value=safe_status), patch.object(
            phase9_acceptance.phase8_acceptance, "acceptance_status",
            return_value={"accepted": True, "mode": "phase8_secure_authenticated_web_acceptance_v1"},
        ):
            accepted = phase9_acceptance.acceptance_status()
        self.assertTrue(accepted["accepted"], accepted["failed_checks"])
        self.assertEqual(accepted["check_count"], 10)
        self.assertFalse(accepted["new_executor"])
        self.assertFalse(accepted["mutations"])

        with patch.object(phase9_acceptance.knowledge, "status", return_value=safe_status), patch.object(
            phase9_acceptance.phase8_acceptance, "acceptance_status",
            return_value={"accepted": False, "mode": "phase8_secure_authenticated_web_acceptance_v1"},
        ):
            failed = phase9_acceptance.acceptance_status()
        self.assertFalse(failed["accepted"])
        self.assertIn("phase8_baseline_preserved", failed["failed_checks"])


if __name__ == "__main__":
    unittest.main()

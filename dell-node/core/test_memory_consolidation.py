import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, execution, memory_candidates, memory_service


class MemoryConsolidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.settings_patch = patch.object(
            db, "settings", replace(db.settings, sqlite_path=self.db_path)
        )
        self.settings_patch.start()
        db.initialise()
        execution.initialise_execution_store()

    def tearDown(self):
        self.settings_patch.stop()
        self.temp.cleanup()

    def test_exact_duplicate_candidate_is_flagged_and_direct_write_is_suppressed(self):
        first = memory_service.create_memory("fact", "Evie likes swimming", "user")
        candidate = memory_service.propose_memory_candidate(
            "  evie   likes swimming  ", memory_type="fact", source="test"
        )
        self.assertEqual(candidate["state"], "duplicate")
        self.assertEqual(candidate["duplicate_memory_id"], first["id"])

        duplicate = memory_service.create_memory("fact", "evie likes swimming", "user")
        self.assertEqual(duplicate["id"], first["id"])
        with db.connection() as connection:
            count = connection.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        self.assertEqual(count, 1)

    def test_new_candidate_does_not_become_memory_until_promoted(self):
        result = asyncio.run(execution.execute_tool(
            request_id="req-propose",
            action="memory.candidate.propose",
            arguments={
                "content": "The spare key is in the green drawer",
                "memory_type": "fact",
                "source": "local-context",
            },
        ))
        self.assertEqual(result["state"], "completed")
        self.assertIn(result["result"]["candidate"]["state"], {"pending", "conflict", "duplicate"})
        self.assertEqual(db.list_memories(), [])

    def test_opposing_fact_is_flagged_as_conflict_not_auto_replaced(self):
        old = memory_service.create_memory("preference", "Evie likes wild swimming", "user")
        candidate = memory_service.propose_memory_candidate(
            "Evie dislikes wild swimming", memory_type="preference", source="local-context"
        )
        self.assertEqual(candidate["state"], "conflict")
        self.assertEqual(candidate["conflict_memory_id"], old["id"])
        self.assertIsNotNone(memory_service.get_memory(old["id"]))
        self.assertFalse(memory_candidates.is_superseded(old["id"]))

    def test_conflict_promotion_requires_exact_approval_and_supersedes_old_context(self):
        old = memory_service.create_memory("preference", "Evie likes wild swimming", "user")
        candidate = memory_service.propose_memory_candidate(
            "Evie dislikes wild swimming", memory_type="preference", source="local-context"
        )
        arguments = {
            "candidate_id": candidate["id"],
            "supersede_memory_id": old["id"],
        }

        first = asyncio.run(execution.execute_tool(
            request_id="req-promote",
            action="memory.candidate.promote",
            arguments=arguments,
        ))
        self.assertEqual(first["state"], "approval_required")
        self.assertFalse(memory_candidates.is_superseded(old["id"]))
        self.assertTrue(db.resolve_approval(first["approval"]["id"], True))

        promoted = asyncio.run(execution.execute_tool(
            request_id="req-promote",
            action="memory.candidate.promote",
            arguments=arguments,
        ))
        self.assertEqual(promoted["state"], "completed")
        self.assertTrue(promoted["verification"]["ok"])
        new_id = promoted["result"]["memory"]["id"]
        self.assertNotEqual(new_id, old["id"])
        self.assertTrue(memory_candidates.is_superseded(old["id"]))

        # The old fact is retained for audit/history but no longer participates
        # in normal memory context selection.
        self.assertEqual(memory_service.get_memory(old["id"])["content"], "Evie likes wild swimming")
        context = memory_service.retrieve_context("Evie wild swimming", 8)
        contents = [item["content"] for item in context if item["kind"] == "memory"]
        self.assertIn("Evie dislikes wild swimming", contents)
        self.assertNotIn("Evie likes wild swimming", contents)

    def test_conflict_cannot_promote_without_naming_flagged_supersession(self):
        memory_service.create_memory("preference", "Evie likes wild swimming", "user")
        candidate = memory_service.propose_memory_candidate(
            "Evie dislikes wild swimming", memory_type="preference", source="local-context"
        )
        first = asyncio.run(execution.execute_tool(
            request_id="req-bad-promote",
            action="memory.candidate.promote",
            arguments={"candidate_id": candidate["id"]},
        ))
        self.assertEqual(first["state"], "approval_required")
        self.assertTrue(db.resolve_approval(first["approval"]["id"], True))
        second = asyncio.run(execution.execute_tool(
            request_id="req-bad-promote",
            action="memory.candidate.promote",
            arguments={"candidate_id": candidate["id"]},
        ))
        self.assertEqual(second["state"], "failed")
        self.assertIn("explicit supersession", second["error"])

    def test_dismissal_is_local_working_state_and_does_not_create_memory(self):
        candidate = memory_service.propose_memory_candidate(
            "Potential temporary fact", source="test"
        )
        result = asyncio.run(execution.execute_tool(
            request_id="req-dismiss",
            action="memory.candidate.dismiss",
            arguments={"candidate_id": candidate["id"]},
        ))
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["result"]["candidate"]["state"], "dismissed")
        self.assertEqual(db.list_memories(), [])

    def test_deleting_replacement_reactivates_previous_memory(self):
        old = memory_service.create_memory("preference", "Evie likes wild swimming", "user")
        candidate = memory_service.propose_memory_candidate(
            "Evie dislikes wild swimming", memory_type="preference", source="local-context"
        )
        promoted = memory_service.promote_memory_candidate(
            candidate["id"], supersede_memory_id=old["id"], request_id="req-direct"
        )
        new_id = promoted["memory"]["id"]
        self.assertTrue(memory_candidates.is_superseded(old["id"]))

        self.assertTrue(memory_service.delete_memory(new_id, request_id="req-delete"))
        self.assertFalse(memory_candidates.is_superseded(old["id"]))
        context = memory_service.retrieve_context("Evie wild swimming", 8)
        contents = [item["content"] for item in context if item["kind"] == "memory"]
        self.assertIn("Evie likes wild swimming", contents)


if __name__ == "__main__":
    unittest.main()

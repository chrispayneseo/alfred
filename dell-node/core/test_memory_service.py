import asyncio
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, inbox_api, memory_service


class MemoryServiceTests(unittest.TestCase):
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

    def test_memory_crud_uses_one_service_boundary(self):
        created = memory_service.create_memory("note", "Spare key is in the blue drawer", "test", request_id="req-memory")
        memory_id = created["id"]
        self.assertEqual(memory_service.get_memory(memory_id)["content"], "Spare key is in the blue drawer")
        self.assertEqual(memory_service.search_memories("blue")[0]["id"], memory_id)

        corrected = memory_service.correct_memory(memory_id, "Spare key is in the green drawer", request_id="req-memory")
        self.assertEqual(corrected["content"], "Spare key is in the green drawer")
        self.assertEqual(memory_service.search_memories("blue"), [])
        self.assertEqual(memory_service.search_memories("green")[0]["id"], memory_id)

        self.assertTrue(memory_service.delete_memory(memory_id, request_id="req-memory"))
        self.assertIsNone(memory_service.get_memory(memory_id))

    def test_context_retrieval_spans_memories_tasks_and_reminders(self):
        memory_service.create_memory("note", "Boiler warranty is in the filing cabinet", "test")
        task = inbox_api.ManualFiling(
            source_id="manual:aa778937-58b9-4c63-b22a-123451234512",
            kind="task", title="Check loft insulation", detail="Get a quote",
        )
        reminder = inbox_api.ManualFiling(
            source_id="manual:cc778937-58b9-4c63-b22a-123451234512",
            kind="reminder", title="Renew car insurance", due="2099-09-26",
        )
        asyncio.run(inbox_api.create_filed(task))
        asyncio.run(inbox_api.create_filed(reminder))

        self.assertEqual(memory_service.retrieve_context("boiler warranty")[0]["kind"], "memory")
        self.assertEqual(memory_service.retrieve_context("loft insulation")[0]["kind"], "task")
        self.assertEqual(memory_service.retrieve_context("car insurance")[0]["kind"], "reminder")

    def test_context_retrieval_degrades_to_memory_if_inbox_index_is_unavailable(self):
        memory_service.create_memory("note", "Recovery code is in the safe", "test")
        with db.connection() as connection:
            connection.execute("DROP TABLE inbox_filed_fts")
        results = memory_service.retrieve_context("recovery code")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["kind"], "memory")
        self.assertEqual(results[0]["content"], "Recovery code is in the safe")

    def test_resource_search_remains_memory_only(self):
        memory_service.create_memory("note", "Loft note for insulation", "test")
        task = inbox_api.ManualFiling(
            source_id="manual:dd778937-58b9-4c63-b22a-123451234512",
            kind="task", title="Loft insulation task", detail="Get a quote",
        )
        asyncio.run(inbox_api.create_filed(task))

        resource_results = memory_service.search_memories("loft insulation")
        context_results = memory_service.retrieve_context("loft insulation")
        self.assertEqual(len(resource_results), 1)
        self.assertEqual(resource_results[0]["kind"], "note")
        self.assertEqual({item["kind"] for item in context_results}, {"memory", "task"})

    def test_mutations_write_audit_events(self):
        item = memory_service.create_memory("note", "Audit me", "test", request_id="req-audit")
        memory_service.correct_memory(item["id"], "Audit me corrected", request_id="req-audit")
        memory_service.delete_memory(item["id"], request_id="req-audit")
        with db.connection() as connection:
            events = connection.execute(
                "SELECT event_type FROM audit_events WHERE request_id = ? ORDER BY occurred_at, rowid",
                ("req-audit",),
            ).fetchall()
        self.assertEqual([row["event_type"] for row in events], [
            "memory.saved", "memory.corrected", "memory.deleted"
        ])


if __name__ == "__main__":
    unittest.main()

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, inbox_api, memory_context, memory_service


class MemoryContextTests(unittest.TestCase):
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

    def test_new_memory_gets_structured_metadata_and_fingerprint(self):
        item = memory_service.create_memory(
            "preference", "Coffee preference is flat white", "user"
        )
        metadata = memory_service.get_memory_attributes(item["id"])
        self.assertEqual(metadata["memory_type"], "preference")
        self.assertEqual(metadata["importance"], 0.85)
        self.assertEqual(metadata["confidence"], 1.0)
        self.assertTrue(metadata["fingerprint"])
        self.assertEqual(metadata["access_count"], 0)

    def test_pre_phase2_memory_metadata_is_hydrated_on_first_use(self):
        memory_id = db.remember("note", "Garden gate key is in the shed", "legacy-import")
        # Simulate the neutral migration row created for an existing database.
        with db.connection() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO memory_metadata(memory_id, memory_type) VALUES (?, 'note')",
                (memory_id,),
            )
        pack = memory_service.build_context_pack("garden gate key")
        self.assertEqual(pack["items"][0]["id"], f"memory:{memory_id}")
        metadata = memory_service.get_memory_attributes(memory_id)
        self.assertTrue(metadata["fingerprint"])
        self.assertEqual(metadata["memory_type"], "note")

    def test_importance_can_change_order_when_relevance_is_similar(self):
        first = memory_service.create_memory("note", "Boiler service company Alpha Heating", "user")
        second = memory_service.create_memory("note", "Boiler service company Beta Heating", "user")
        memory_service.update_memory_attributes(first["id"], importance=0.05)
        memory_service.update_memory_attributes(second["id"], importance=1.0)

        results = memory_service.retrieve_context("boiler service company", 2)
        self.assertEqual(results[0]["id"], f"memory:{second['id']}")
        self.assertGreater(results[0]["score"], results[1]["score"])
        self.assertIn("score_components", results[0])

    def test_exact_duplicate_context_is_suppressed(self):
        memory_service.create_memory("note", "Passport copies are in the blue folder", "user")
        memory_service.create_memory("note", "Passport copies are in the blue folder", "api")
        pack = memory_service.build_context_pack("passport copies blue folder", limit=10)
        matching = [item for item in pack["items"] if "Passport copies" in item["content"]]
        self.assertEqual(len(matching), 1)
        self.assertGreater(pack["budget"]["candidates"], pack["budget"]["deduplicated_candidates"])

    def test_context_budget_caps_large_memories(self):
        memory_service.create_memory("note", "Workshop manual " + ("details " * 450), "user")
        pack = memory_service.build_context_pack("workshop manual", limit=5, max_chars=700)
        self.assertEqual(pack["ranking"], "phase2-v1")
        self.assertLessEqual(pack["budget"]["used_chars"], 700)
        self.assertEqual(len(pack["items"]), 1)
        self.assertLess(len(pack["items"][0]["content"]), 700)

    def test_selected_memory_records_access_without_changing_content(self):
        item = memory_service.create_memory("fact", "Garage code hint is stored offline", "user")
        before = memory_service.get_memory(item["id"])["content"]
        memory_service.retrieve_context("garage code hint")
        metadata = memory_service.get_memory_attributes(item["id"])
        after = memory_service.get_memory(item["id"])["content"]
        self.assertEqual(metadata["access_count"], 1)
        self.assertIsNotNone(metadata["last_accessed_at"])
        self.assertEqual(before, after)

    def test_attribute_values_are_bounded(self):
        item = memory_service.create_memory("note", "Bounded memory", "user")
        with self.assertRaises(ValueError):
            memory_context.set_memory_attributes(item["id"], importance=1.1)
        with self.assertRaises(ValueError):
            memory_context.set_memory_attributes(item["id"], confidence=-0.1)


if __name__ == "__main__":
    unittest.main()

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, inbox_api, memory_graph, memory_service


class MemoryGraphTests(unittest.TestCase):
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

    def test_related_memories_get_local_rebuildable_edge(self):
        first = memory_service.create_memory(
            "fact", "Boiler manual stored in blue drawer", "user"
        )
        second = memory_service.create_memory(
            "fact", "Blue drawer holds warranty certificate", "user"
        )
        relations = memory_service.get_memory_relations(first["id"])
        self.assertEqual(len(relations), 1)
        self.assertEqual(relations[0]["related_memory_id"], second["id"])
        self.assertEqual(relations[0]["relation"], "lexical_overlap")
        self.assertGreaterEqual(relations[0]["confidence"], 0.74)

    def test_unrelated_memories_do_not_get_edge(self):
        first = memory_service.create_memory("fact", "Boiler manual stored in blue drawer", "user")
        memory_service.create_memory("preference", "Favourite coffee is a flat white", "user")
        self.assertEqual(memory_service.get_memory_relations(first["id"]), [])

    def test_query_can_expand_to_related_memory_without_direct_term_match(self):
        first = memory_service.create_memory(
            "fact", "Boiler manual stored in blue drawer", "user"
        )
        second = memory_service.create_memory(
            "fact", "Blue drawer holds warranty certificate", "user"
        )
        pack = memory_service.build_context_pack("boiler manual", limit=6, max_chars=3000)
        ids = [item["id"] for item in pack["items"]]
        self.assertIn(f"memory:{first['id']}", ids)
        self.assertIn(f"memory:{second['id']}", ids)
        related = next(item for item in pack["items"] if item["id"] == f"memory:{second['id']}")
        self.assertEqual(related["relation"]["type"], "lexical_overlap")
        self.assertEqual(related["relation"]["from_memory_id"], first["id"])
        self.assertEqual(pack["graph"]["expanded"], 1)

    def test_correction_rebuilds_and_removes_stale_edge(self):
        first = memory_service.create_memory("fact", "Boiler manual stored in blue drawer", "user")
        second = memory_service.create_memory("fact", "Blue drawer holds warranty certificate", "user")
        self.assertEqual(len(memory_service.get_memory_relations(first["id"])), 1)

        memory_service.correct_memory(second["id"], "Passport renewal appointment is next month")
        self.assertEqual(memory_service.get_memory_relations(first["id"]), [])
        self.assertEqual(memory_service.get_memory_relations(second["id"]), [])

    def test_delete_removes_graph_edges(self):
        first = memory_service.create_memory("fact", "Boiler manual stored in blue drawer", "user")
        second = memory_service.create_memory("fact", "Blue drawer holds warranty certificate", "user")
        self.assertEqual(len(memory_service.get_memory_relations(first["id"])), 1)
        self.assertTrue(memory_service.delete_memory(second["id"]))
        self.assertEqual(memory_service.get_memory_relations(first["id"]), [])
        with db.connection() as connection:
            count = connection.execute("SELECT COUNT(*) FROM memory_relations").fetchone()[0]
        self.assertEqual(count, 0)

    def test_graph_expansion_respects_existing_context_budget(self):
        memory_service.create_memory("fact", "Boiler manual stored in blue drawer " + ("manual " * 80), "user")
        memory_service.create_memory("fact", "Blue drawer holds warranty certificate " + ("warranty " * 80), "user")
        pack = memory_service.build_context_pack("boiler manual", limit=6, max_chars=650)
        self.assertLessEqual(pack["budget"]["used_chars"], 650)

    def test_similarity_is_deterministic_and_requires_two_shared_terms(self):
        score, shared = memory_graph.similarity(
            "Blue drawer boiler manual", "Blue drawer warranty certificate"
        )
        self.assertEqual(shared, 2)
        self.assertGreater(score, 0)
        _, shared = memory_graph.similarity("Boiler manual", "Boiler warranty")
        self.assertEqual(shared, 1)
        self.assertLess(shared, memory_graph.MIN_SHARED_TERMS)


if __name__ == "__main__":
    unittest.main()

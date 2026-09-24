import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, memory_candidates, memory_service


class CandidateLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.settings_patch = patch.object(
            db, "settings", replace(db.settings, sqlite_path=self.db_path)
        )
        self.settings_patch.start()
        db.initialise()
        memory_candidates.initialise()

    def tearDown(self):
        self.settings_patch.stop()
        self.temp.cleanup()

    def _age(self, candidate_id: str, days: int, *, resolved: bool = False):
        column = "resolved_at" if resolved else "created_at"
        with db.connection() as connection:
            connection.execute(
                f"UPDATE memory_candidates SET {column} = datetime('now', ?) WHERE id = ?",
                (f"-{days} days", candidate_id),
            )

    def test_pending_expires_after_thirty_days(self):
        candidate = memory_service.propose_memory_candidate(
            "I prefer quiet hotel rooms", memory_type="preference", source="test"
        )
        self.assertEqual(candidate["state"], "pending")
        self._age(candidate["id"], 31)

        maintenance = memory_candidates.maintain()
        self.assertEqual(maintenance["expired_pending"], 1)
        self.assertEqual(memory_candidates.get(candidate["id"])["state"], "expired")

    def test_conflict_has_longer_ninety_day_review_window(self):
        memory_service.create_memory("preference", "Evie likes wild swimming", "user")
        candidate = memory_service.propose_memory_candidate(
            "Evie dislikes wild swimming", memory_type="preference", source="test"
        )
        self.assertEqual(candidate["state"], "conflict")

        self._age(candidate["id"], 45)
        memory_candidates.maintain()
        self.assertEqual(memory_candidates.get(candidate["id"])["state"], "conflict")

        self._age(candidate["id"], 91)
        maintenance = memory_candidates.maintain()
        self.assertEqual(maintenance["expired_conflicts"], 1)
        self.assertEqual(memory_candidates.get(candidate["id"])["state"], "expired")

    def test_resolved_and_expired_candidate_rows_are_purged_after_thirty_more_days(self):
        first = memory_service.propose_memory_candidate(
            "I prefer aisle seats", memory_type="preference", source="test"
        )
        memory_service.dismiss_memory_candidate(first["id"])
        self._age(first["id"], 31, resolved=True)

        second = memory_service.propose_memory_candidate(
            "I prefer window seats", memory_type="preference", source="test"
        )
        self._age(second["id"], 31)
        memory_candidates.maintain()  # pending -> expired with a fresh resolved_at
        self._age(second["id"], 31, resolved=True)

        maintenance = memory_candidates.maintain()
        self.assertEqual(maintenance["purged"], 2)
        self.assertIsNone(memory_candidates.get(first["id"]))
        self.assertIsNone(memory_candidates.get(second["id"]))

    def test_candidate_cleanup_never_deletes_durable_memory_or_supersession_history(self):
        old = memory_service.create_memory("preference", "Evie likes wild swimming", "user")
        candidate = memory_service.propose_memory_candidate(
            "Evie dislikes wild swimming", memory_type="preference", source="test"
        )
        promoted = memory_service.promote_memory_candidate(
            candidate["id"], supersede_memory_id=old["id"], request_id="req-promote"
        )
        new_id = promoted["memory"]["id"]
        self._age(candidate["id"], 31, resolved=True)

        memory_candidates.maintain()
        self.assertIsNotNone(memory_service.get_memory(old["id"]))
        self.assertIsNotNone(memory_service.get_memory(new_id))
        self.assertTrue(memory_candidates.is_superseded(old["id"]))
        self.assertIsNone(memory_candidates.get(candidate["id"]))

    def test_review_summary_reports_open_conflicts_and_retention(self):
        memory_service.create_memory("preference", "Evie likes wild swimming", "user")
        memory_service.propose_memory_candidate(
            "I prefer dark mode", memory_type="preference", source="test"
        )
        memory_service.propose_memory_candidate(
            "Evie dislikes wild swimming", memory_type="preference", source="test"
        )

        summary = memory_candidates.review_summary()
        self.assertEqual(summary["open"], 2)
        self.assertEqual(summary["conflicts"], 1)
        self.assertEqual(summary["retention"], {
            "pending_days": 30,
            "conflict_days": 90,
            "resolved_days": 30,
        })
        self.assertIsNotNone(summary["oldest_open_at"])

    def test_expired_candidate_cannot_be_promoted(self):
        candidate = memory_service.propose_memory_candidate(
            "I prefer quiet hotel rooms", memory_type="preference", source="test"
        )
        self._age(candidate["id"], 31)
        with self.assertRaisesRegex(ValueError, "Expired candidate"):
            memory_candidates.validate_promotion(candidate["id"])
        self.assertEqual(db.list_memories(), [])


if __name__ == "__main__":
    unittest.main()

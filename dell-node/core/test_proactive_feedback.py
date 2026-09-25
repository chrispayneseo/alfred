import json
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app import db, proactive, proactive_feedback


class ProactiveFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.db_patch.start()
        db.initialise()
        proactive.initialise()
        proactive_feedback.initialise()
        self.now = datetime(2026, 9, 25, 12, 0, tzinfo=ZoneInfo("Europe/London"))

    def tearDown(self):
        self.db_patch.stop()
        self.temp.cleanup()

    def _insert_item(self, *, item_id: str, source: str, kind: str, priority: int = 72):
        with db.connection() as conn:
            conn.execute("""INSERT INTO proactive_items
                (id, fingerprint, kind, source, priority, title, summary, source_ref)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL)""",
                (item_id, f"fp-{item_id}", kind, source, priority, "Private title", "Private summary"),
            )

    def test_dismissal_creates_content_free_bounded_penalty(self):
        self._insert_item(item_id="mail-1", source="gmail", kind="gmail_booking", priority=72)
        self.assertTrue(proactive_feedback.record_action("mail-1", "dismiss", now=self.now))

        result = proactive_feedback.apply_feedback([{
            "id": "next-mail",
            "source": "gmail",
            "kind": "gmail_booking",
            "priority": 72,
            "title": "Booking or travel email",
            "summary": "Generic summary",
        }], now=self.now)

        item = result["items"][0]
        self.assertEqual(item["priority"], 66)
        self.assertEqual(item["feedback_adjustment"], -6)
        self.assertEqual(result["adjusted_items"], 1)
        self.assertFalse(result["creates_urgent"])
        self.assertFalse(result["demotes_urgent"])
        self.assertFalse(result["cloud_models"])
        self.assertFalse(result["stores_connected_content"])
        encoded = json.dumps(result)
        self.assertNotIn("Private title", encoded)
        self.assertNotIn("Private summary", encoded)

    def test_one_snooze_is_timing_only_but_repeated_snooze_is_small_signal(self):
        self._insert_item(item_id="task-1", source="tasks", kind="due_soon", priority=72)
        self.assertTrue(proactive_feedback.record_action("task-1", "snooze", now=self.now))
        once = proactive_feedback.apply_feedback([{
            "id": "task-next",
            "source": "tasks",
            "kind": "due_soon",
            "priority": 72,
        }], now=self.now)
        self.assertEqual(once["items"][0]["priority"], 72)

        self.assertTrue(proactive_feedback.record_action("task-1", "snooze", now=self.now))
        twice = proactive_feedback.apply_feedback([{
            "id": "task-next",
            "source": "tasks",
            "kind": "due_soon",
            "priority": 72,
        }], now=self.now)
        self.assertEqual(twice["items"][0]["priority"], 70)
        self.assertEqual(twice["items"][0]["feedback_adjustment"], -2)

    def test_feedback_never_demotes_existing_urgent_item(self):
        self._insert_item(item_id="urgent-1", source="tasks", kind="overdue", priority=94)
        for _ in range(4):
            self.assertTrue(proactive_feedback.record_action("urgent-1", "dismiss", now=self.now))
        result = proactive_feedback.apply_feedback([{
            "id": "urgent-next",
            "source": "tasks",
            "kind": "overdue",
            "priority": 94,
        }], now=self.now)
        self.assertEqual(result["items"][0]["priority"], 94)
        self.assertNotIn("feedback_adjustment", result["items"][0])

    def test_wrapped_dismiss_does_not_double_learn_immediate_retry(self):
        self._insert_item(item_id="mail-2", source="gmail", kind="unread_email", priority=58)
        self.assertTrue(proactive.dismiss("mail-2"))
        self.assertTrue(proactive.dismiss("mail-2"))
        state = proactive_feedback.status(now=self.now)
        self.assertEqual(state["dismissals"], 1)

    def test_feedback_reset_is_local_and_complete(self):
        self._insert_item(item_id="mail-3", source="gmail", kind="gmail_delivery", priority=66)
        self.assertTrue(proactive_feedback.record_action("mail-3", "dismiss", now=self.now))
        self.assertEqual(proactive_feedback.status(now=self.now)["dismissals"], 1)
        self.assertEqual(proactive_feedback.reset(), 1)
        state = proactive_feedback.status(now=self.now)
        self.assertEqual(state["dismissals"], 0)
        self.assertEqual(state["snoozes"], 0)
        self.assertEqual(state["learned_kinds"], 0)

    def test_routes_are_registered(self):
        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/proactive/feedback/status", paths)
        self.assertIn("/v1/core/proactive/feedback/reset", paths)


if __name__ == "__main__":
    unittest.main()

import asyncio
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch
from zoneinfo import ZoneInfo

from app import db as core_db
from app import inbox_api


class InboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.inbox_path = str(base / "inbox.sqlite3")
        self.patch_path = patch.object(inbox_api, "INBOX_DB", self.inbox_path)
        self.patch_settings = patch.object(core_db, "settings", replace(core_db.settings, sqlite_path=str(base / "core.sqlite3")))
        self.patch_path.start()
        self.patch_settings.start()
        core_db.initialise()
        inbox_api.initialise()

    def tearDown(self):
        self.patch_settings.stop()
        self.patch_path.stop()
        self.temp.cleanup()

    def insert(self, message_id="wamid.sample.test"):
        with sqlite3.connect(self.inbox_path) as db:
            db.execute("INSERT INTO whatsapp_inbox (id, body, sent_at, received_at) VALUES (?, ?, '', '')",
                       (message_id, "Remind me to call Sam tomorrow"))

    def test_note_requires_approval_and_retries_do_not_duplicate_memory(self):
        self.insert()
        self.assertEqual(core_db.list_memories(), [])
        filing = inbox_api.Filing(kind="note", title="Call Sam", detail="Tomorrow")
        asyncio.run(inbox_api.file_message("wamid.sample.test", filing))
        asyncio.run(inbox_api.file_message("wamid.sample.test", filing))
        self.assertEqual(len(core_db.list_memories()), 1)
        self.assertEqual(inbox_api.rows()[0]["state"], "filed")

    def test_reminder_requires_date(self):
        self.insert()
        with self.assertRaises(Exception) as raised:
            asyncio.run(inbox_api.file_message("wamid.sample.test", inbox_api.Filing(kind="reminder", title="Call Sam")))
        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(inbox_api.rows()[0]["state"], "new")

    def test_discard_deletes_only_unfiled_message(self):
        self.insert()
        asyncio.run(inbox_api.discard_message("wamid.sample.test"))
        self.assertEqual(inbox_api.rows(), [])

    def test_triage_only_suggests_and_never_files(self):
        self.insert()
        suggestion = {"kind": "note", "title": "Call Sam", "due": None, "detail": ""}
        with patch.object(inbox_api, "classify", new=AsyncMock(return_value=suggestion)):
            self.assertEqual(asyncio.run(inbox_api.triage_new()), 1)
        self.assertEqual(inbox_api.rows()[0]["state"], "review")
        self.assertEqual(core_db.list_memories(), [])

    def test_dates_must_be_iso(self):
        self.assertEqual(inbox_api.parse_due("2026-09-25"), "2026-09-25")
        with self.assertRaises(ValueError):
            inbox_api.parse_due("tomorrow")

    def test_model_cannot_invent_task_deadline(self):
        result = inbox_api.normalise_suggestion("Add a task to check the loft insulation.", {
            "kind": "task", "title": "Check loft insulation", "due": inbox_api.local_today().isoformat(), "detail": "",
        })
        self.assertEqual(result["kind"], "task")
        self.assertIsNone(result["due"])

    def test_explicit_date_is_kept_and_undated_reminder_needs_review(self):
        dated = inbox_api.normalise_suggestion("Remind me on 2026-09-26 to renew the policy.", {
            "kind": "reminder", "title": "Renew policy", "due": "2026-09-26", "detail": "",
        })
        self.assertEqual(dated["due"], "2026-09-26")
        undated = inbox_api.normalise_suggestion("Remind me to renew the policy.", {
            "kind": "reminder", "title": "Renew policy", "due": "2026-09-26", "detail": "",
        })
        self.assertEqual(undated["kind"], "clarify")
        self.assertIsNone(undated["due"])

    def test_manual_task_is_idempotent_and_can_be_completed(self):
        filing = inbox_api.ManualFiling(source_id="manual:bb778937-58b9-4c63-b22a-123451234512",
                                        kind="task", title="Check loft", detail="")
        asyncio.run(inbox_api.create_filed(filing))
        asyncio.run(inbox_api.create_filed(filing))
        self.assertEqual(len(asyncio.run(inbox_api.get_filed())["items"]), 1)
        asyncio.run(inbox_api.set_completion(filing.source_id, inbox_api.Completion(completed=True)))
        self.assertIsNotNone(asyncio.run(inbox_api.get_filed())["items"][0]["completed_at"])
        asyncio.run(inbox_api.set_completion(filing.source_id, inbox_api.Completion(completed=False)))
        self.assertIsNone(asyncio.run(inbox_api.get_filed())["items"][0]["completed_at"])

    def test_manual_reminder_requires_date(self):
        filing = inbox_api.ManualFiling(source_id="manual:bb778937-58b9-4c63-b22a-123451234512",
                                        kind="reminder", title="Renew policy")
        with self.assertRaises(Exception) as raised:
            asyncio.run(inbox_api.create_filed(filing))
        self.assertEqual(raised.exception.status_code, 422)

    def test_notification_is_generic_once_and_waits_until_due_hour(self):
        filing = inbox_api.ManualFiling(source_id="manual:bb778937-58b9-4c63-b22a-123451234512",
                                        kind="reminder", title="Private medical appointment", due="2026-09-26")
        asyncio.run(inbox_api.create_filed(filing))
        topic = "a" * 40
        with patch.dict("os.environ", {"ALFRED_NTFY_TOPIC": topic, "ALFRED_REMINDER_HOUR": "9"}), \
             patch("app.inbox_api.httpx.AsyncClient") as client:
            response = client.return_value.__aenter__.return_value.post
            response.return_value = Mock()
            before = datetime(2026, 9, 26, 8, 59, tzinfo=ZoneInfo("Europe/London"))
            after = datetime(2026, 9, 26, 9, 0, tzinfo=ZoneInfo("Europe/London"))
            self.assertEqual(asyncio.run(inbox_api.notify_due_reminders(before)), 0)
            self.assertEqual(asyncio.run(inbox_api.notify_due_reminders(after)), 1)
            self.assertEqual(asyncio.run(inbox_api.notify_due_reminders(after)), 0)
            self.assertNotIn("Private medical appointment", response.call_args.kwargs["content"])
        self.assertIsNotNone(asyncio.run(inbox_api.get_filed())["items"][0]["notified_at"])


if __name__ == "__main__":
    unittest.main()

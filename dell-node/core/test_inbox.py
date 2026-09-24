import asyncio
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

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


if __name__ == "__main__":
    unittest.main()

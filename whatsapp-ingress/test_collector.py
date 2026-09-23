import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import collector


MESSAGE = {
    "id": "wamid.test_message_12345678=",
    "body": "Remember the appointment",
    "sent_at": "123",
    "received_at": "2026-09-23T22:00:00Z",
}


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = collector.open_database(str(Path(self.temp.name) / "inbox.sqlite3"))
        self.addCleanup(self.db.close)

    def test_persists_before_ack_and_is_idempotent(self):
        calls = []

        def fake_request(url, token, *, body=None):
            if url.endswith("/inbox"):
                return {"messages": [MESSAGE]}
            stored = self.db.execute("SELECT body FROM whatsapp_inbox WHERE id = ?", (MESSAGE["id"],)).fetchone()
            self.assertEqual(stored[0], MESSAGE["body"])
            calls.append(body["id"])
            return {"ok": True}

        with patch.object(collector, "request_json", side_effect=fake_request):
            self.assertEqual(collector.collect_once(self.db, "https://ingress.example", "t" * 40), 1)
            self.assertEqual(collector.collect_once(self.db, "https://ingress.example", "t" * 40), 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM whatsapp_inbox").fetchone()[0], 1)

    def test_rejects_http_and_malformed_messages_without_ack(self):
        with self.assertRaises(ValueError):
            collector.collect_once(self.db, "http://ingress.example", "t" * 40)
        with patch.object(collector, "request_json", return_value={"messages": [{"id": "bad", "body": "test"}]}) as request:
            with self.assertRaises(ValueError):
                collector.collect_once(self.db, "https://ingress.example", "t" * 40)
            self.assertEqual(request.call_count, 1)

    def test_database_failure_does_not_ack(self):
        self.db.execute("DROP TABLE whatsapp_inbox")
        with patch.object(collector, "request_json", return_value={"messages": [MESSAGE]}) as request:
            with self.assertRaises(sqlite3.Error):
                collector.collect_once(self.db, "https://ingress.example", "t" * 40)
            self.assertEqual(request.call_count, 1)


if __name__ == "__main__":
    unittest.main()

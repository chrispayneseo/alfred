import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db


class ApprovalMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.patch_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.patch_settings.start()

    def tearDown(self):
        self.patch_settings.stop()
        self.temp.cleanup()

    def test_existing_approval_table_is_upgraded_without_losing_rows(self):
        with sqlite3.connect(self.db_path) as connection:
            connection.execute("""CREATE TABLE approvals (
              id TEXT PRIMARY KEY, request_id TEXT, plan_id TEXT, action TEXT NOT NULL,
              summary TEXT NOT NULL, risk_level TEXT NOT NULL, state TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT
            )""")
            connection.execute("""INSERT INTO approvals
              (id, request_id, plan_id, action, summary, risk_level, state)
              VALUES ('old-approval', 'req-old', NULL, 'memory.write', 'Legacy', 'safe_write', 'approved')""")

        db.initialise()

        with db.connection() as connection:
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(approvals)").fetchall()}
            row = connection.execute(
                "SELECT id, state, scope_hash, step_index FROM approvals WHERE id = 'old-approval'"
            ).fetchone()
        self.assertIn("scope_hash", columns)
        self.assertIn("step_index", columns)
        self.assertEqual(row["state"], "approved")
        self.assertIsNone(row["scope_hash"])
        self.assertIsNone(row["step_index"])


if __name__ == "__main__":
    unittest.main()

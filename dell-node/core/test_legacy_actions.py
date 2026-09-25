import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app import config, db, execution, inbox_api, integration_adapters, main


class LegacyActionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.db_path = str(base / "core.sqlite3")
        self.patch_db_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.patch_execution_connection = patch.object(execution, "connection", db.connection)
        self.patch_inbox_path = patch.object(inbox_api, "INBOX_DB", str(base / "inbox.sqlite3"))
        self.patch_db_settings.start()
        self.patch_execution_connection.start()
        self.patch_inbox_path.start()
        db.initialise()
        inbox_api.initialise()
        execution.initialise_execution_store()

    def tearDown(self):
        self.patch_inbox_path.stop()
        self.patch_execution_connection.stop()
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_unconfirmed_legacy_write_is_only_a_proposal(self):
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(main.create_memory(main.Memory(
                kind="note", content="Do not save yet", source="test", confirmed=False
            )))
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(db.list_memories(), [])
        with db.connection() as connection:
            approvals = connection.execute("SELECT COUNT(*) AS count FROM approvals").fetchone()["count"]
            executions = connection.execute("SELECT COUNT(*) AS count FROM core_executions").fetchone()["count"]
        self.assertEqual(approvals, 0)
        self.assertEqual(executions, 0)

    def test_confirmed_legacy_write_uses_scoped_approval_and_executor(self):
        response = asyncio.run(main.create_memory(main.Memory(
            kind="note", content="Save through Core", source="test", confirmed=True
        )))
        self.assertEqual(db.get_memory(response["id"])["content"], "Save through Core")
        with db.connection() as connection:
            approval = connection.execute(
                "SELECT state, scope_hash FROM approvals ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            execution_row = connection.execute(
                "SELECT state, action FROM core_executions ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        self.assertEqual(approval["state"], "approved")
        self.assertTrue(approval["scope_hash"])
        self.assertEqual(execution_row["state"], "completed")
        self.assertEqual(execution_row["action"], "memory.write")

    def test_explicit_delete_routes_through_executor(self):
        memory_id = db.remember("note", "Delete through Core", "test")
        response = asyncio.run(main.delete_memory(memory_id))
        self.assertTrue(response["deleted"])
        self.assertIsNone(db.get_memory(memory_id))
        with db.connection() as connection:
            row = connection.execute(
                "SELECT state, action FROM core_executions ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        self.assertEqual(row["state"], "completed")
        self.assertEqual(row["action"], "memory.delete")

    def test_confirmed_home_assistant_action_routes_through_executor(self):
        configured = replace(config.settings, ha_url="http://ha.local:8123", ha_token="test-token")
        with (
            patch.object(config, "settings", configured),
            patch.object(integration_adapters, "home_assistant", new=AsyncMock(return_value={
                "ok": True, "service": "light.turn_on", "entity_id": "light.study"
            })),
        ):
            response = asyncio.run(main.device_action(main.DeviceAction(
                service="light.turn_on", entity_id="light.study", confirmed=True
            )))
        self.assertTrue(response["ok"])
        with db.connection() as connection:
            row = connection.execute(
                "SELECT state, action FROM core_executions ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        self.assertEqual(row["state"], "completed")
        self.assertEqual(row["action"], "home_assistant.service")


if __name__ == "__main__":
    unittest.main()

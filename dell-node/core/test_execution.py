import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import db, execution, inbox_api


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.db_path = str(base / "core.sqlite3")
        self.patch_db_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.patch_execution_settings = patch.object(execution, "connection", db.connection)
        self.patch_inbox_path = patch.object(inbox_api, "INBOX_DB", str(base / "inbox.sqlite3"))
        self.patch_db_settings.start()
        self.patch_execution_settings.start()
        self.patch_inbox_path.start()
        db.initialise()
        inbox_api.initialise()
        execution.initialise_execution_store()

    def tearDown(self):
        self.patch_inbox_path.stop()
        self.patch_execution_settings.stop()
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_read_tool_executes_and_verifies_without_approval(self):
        db.remember("note", "Blue folder is in the study", "test")
        result = asyncio.run(execution.execute_tool(
            request_id="req-read",
            action="memory.read",
            arguments={"query": "blue folder"},
        ))
        self.assertEqual(result["state"], "completed")
        self.assertTrue(result["verification"]["ok"])
        self.assertEqual(result["verification"]["method"], "read_result")
        self.assertEqual(len(result["result"]["items"]), 1)
        self.assertEqual(result["result"]["items"][0]["kind"], "memory")

    def test_read_tool_can_retrieve_task_context_through_same_service(self):
        task = inbox_api.ManualFiling(
            source_id="manual:bb778937-58b9-4c63-b22a-123451234599",
            kind="task", title="Check loft insulation", detail="Get a quote",
        )
        asyncio.run(inbox_api.create_filed(task))
        result = asyncio.run(execution.execute_tool(
            request_id="req-task-read",
            action="memory.read",
            arguments={"query": "loft insulation"},
        ))
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["result"]["items"][0]["kind"], "task")

    def test_write_requires_durable_approval_then_verifies_stored_row(self):
        first = asyncio.run(execution.execute_tool(
            request_id="req-write",
            action="memory.write",
            arguments={"kind": "note", "content": "Bin day is Thursday"},
        ))
        self.assertEqual(first["state"], "approval_required")
        self.assertEqual(db.list_memories(), [])

        self.assertTrue(db.resolve_approval(first["approval"]["id"], True))
        second = asyncio.run(execution.execute_tool(
            request_id="req-write",
            action="memory.write",
            arguments={"kind": "note", "content": "Bin day is Thursday"},
        ))
        self.assertEqual(second["state"], "completed")
        self.assertTrue(second["verification"]["ok"])
        self.assertEqual(second["verification"]["method"], "stored_row")
        self.assertEqual(db.get_memory(second["result"]["memory_id"])["content"], "Bin day is Thursday")

    def test_unregistered_tool_fails_closed(self):
        result = asyncio.run(execution.execute_tool(
            request_id="req-bad",
            action="shell.execute",
            arguments={"command": "echo no"},
        ))
        self.assertEqual(result["state"], "denied")
        self.assertIn("not registered", result["error"])

    def test_home_assistant_requires_approval_and_verifies_response(self):
        first = asyncio.run(execution.execute_tool(
            request_id="req-ha",
            action="home_assistant.service",
            arguments={"service": "light.turn_on", "entity_id": "light.study"},
        ))
        self.assertEqual(first["state"], "approval_required")
        db.resolve_approval(first["approval"]["id"], True)

        with patch.object(execution, "home_assistant", new=AsyncMock(return_value={
            "ok": True, "service": "light.turn_on", "entity_id": "light.study"
        })):
            second = asyncio.run(execution.execute_tool(
                request_id="req-ha",
                action="home_assistant.service",
                arguments={"service": "light.turn_on", "entity_id": "light.study"},
            ))
        self.assertEqual(second["state"], "completed")
        self.assertTrue(second["verification"]["ok"])
        self.assertEqual(second["verification"]["method"], "service_response")

    def test_plan_pauses_for_approval_then_resumes_without_replaying_completed_step(self):
        db.remember("note", "Existing recovery note", "test")
        plan = db.create_plan("req-plan", "Read then save", [
            {"action": "memory.read", "arguments": {"query": "recovery note"}},
            {"action": "memory.write", "arguments": {"kind": "note", "content": "Plan-created note"}},
        ])

        first = asyncio.run(execution.execute_plan(plan["id"]))
        self.assertEqual(first["state"], "awaiting_approval")
        self.assertEqual(first["executions"][0]["state"], "completed")
        first_read_id = first["executions"][0]["id"]
        approval_id = first["executions"][1]["approval"]["id"]
        db.resolve_approval(approval_id, True)

        second = asyncio.run(execution.execute_plan(plan["id"]))
        self.assertEqual(second["state"], "completed")
        self.assertEqual(second["executions"][0]["id"], first_read_id)
        self.assertTrue(second["executions"][0]["replayed"])
        self.assertEqual(second["executions"][1]["state"], "completed")
        matches = [item for item in db.list_memories(20) if item["content"] == "Plan-created note"]
        self.assertEqual(len(matches), 1)


if __name__ == "__main__":
    unittest.main()

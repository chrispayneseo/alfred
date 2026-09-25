import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, execution, inbox_api, integrations, task_service
from app.core import tool_registry


class TaskToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.execution_connection_patch = patch.object(execution, "connection", db.connection)
        self.db_patch.start()
        self.execution_connection_patch.start()
        db.initialise()
        task_service.initialise()
        execution.initialise_execution_store()

    def tearDown(self):
        self.execution_connection_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    def _approve_and_execute(self, request_id: str, action: str, arguments: dict) -> dict:
        first = asyncio.run(execution.execute_tool(
            request_id=request_id, action=action, arguments=arguments,
        ))
        self.assertEqual(first["state"], "approval_required")
        self.assertTrue(first["approval"]["scope_hash"])
        db.resolve_approval(first["approval"]["id"], True)
        return asyncio.run(execution.execute_tool(
            request_id=request_id, action=action, arguments=arguments,
        ))

    def test_tasks_integration_is_local_and_ready(self):
        integration = integrations.get_integration("alfred_tasks")
        self.assertEqual(integration["state"], "ready")
        self.assertEqual(integration["boundary"], "local")
        self.assertTrue(integration["configured"])
        self.assertTrue(all(not item["sends_off_device"] for item in integration["capabilities"]))
        tools = {item["name"]: item for item in tool_registry()}
        for action in ("tasks.list", "tasks.create", "tasks.update", "tasks.complete", "tasks.delete"):
            self.assertEqual(tools[action]["integration"], "alfred_tasks")

    def test_existing_manual_task_and_core_task_share_one_store(self):
        manual = inbox_api.ManualFiling(
            source_id="manual:bb778937-58b9-4c63-b22a-123451239999",
            kind="task",
            title="Check loft insulation",
            detail="Get a quote",
        )
        asyncio.run(inbox_api.create_filed(manual))

        created = self._approve_and_execute(
            "req-task-create",
            "tasks.create",
            {"kind": "task", "title": "Book boiler service", "detail": "Call installer"},
        )
        self.assertEqual(created["state"], "completed")
        self.assertTrue(created["verification"]["ok"])
        self.assertEqual(created["verification"]["method"], "stored_task")

        listed = asyncio.run(execution.execute_tool(
            request_id="req-task-list",
            action="tasks.list",
            arguments={"limit": 20},
        ))
        self.assertEqual(listed["state"], "completed")
        self.assertIsNone(listed["approval"])
        titles = {item["title"] for item in listed["result"]["items"]}
        self.assertIn("Check loft insulation", titles)
        self.assertIn("Book boiler service", titles)

    def test_create_approval_does_not_duplicate_task_text(self):
        arguments = {
            "kind": "reminder",
            "title": "Private medical appointment wording",
            "due": "2026-10-01",
            "detail": "Private details should not enter approval summary",
        }
        first = asyncio.run(execution.execute_tool(
            request_id="req-private-reminder",
            action="tasks.create",
            arguments=arguments,
        ))
        self.assertEqual(first["state"], "approval_required")
        summary = first["approval"]["summary"]
        self.assertNotIn(arguments["title"], summary)
        self.assertNotIn(arguments["detail"], summary)
        self.assertEqual(task_service.list_items(include_completed=True), [])

    def test_reminder_requires_due_date_after_approval(self):
        arguments = {"kind": "reminder", "title": "Renew insurance"}
        result = self._approve_and_execute(
            "req-reminder-due", "tasks.create", arguments
        )
        self.assertEqual(result["state"], "failed")
        self.assertIn("due date", result["error"])
        self.assertEqual(task_service.list_items(include_completed=True), [])

    def test_update_complete_and_delete_are_each_scoped_mutations(self):
        item = task_service.create(kind="task", title="Original title", detail="Original detail")
        source_id = item["source_id"]

        updated = self._approve_and_execute(
            "req-task-update",
            "tasks.update",
            {"source_id": source_id, "title": "Updated title", "detail": "Updated detail"},
        )
        self.assertEqual(updated["state"], "completed")
        self.assertEqual(task_service.get(source_id)["title"], "Updated title")

        completed = self._approve_and_execute(
            "req-task-complete",
            "tasks.complete",
            {"source_id": source_id, "completed": True},
        )
        self.assertEqual(completed["state"], "completed")
        self.assertTrue(task_service.get(source_id)["completed"])

        deleted = self._approve_and_execute(
            "req-task-delete",
            "tasks.delete",
            {"source_id": source_id},
        )
        self.assertEqual(deleted["state"], "completed")
        self.assertTrue(deleted["verification"]["ok"])
        self.assertEqual(deleted["verification"]["method"], "task_absent")
        self.assertIsNone(task_service.get(source_id))

    def test_changed_task_create_cannot_reuse_prior_approval(self):
        original = {"kind": "task", "title": "First exact task"}
        changed = {"kind": "task", "title": "Changed task"}
        first = asyncio.run(execution.execute_tool(
            request_id="req-task-scope", action="tasks.create", arguments=original,
        ))
        db.resolve_approval(first["approval"]["id"], True)
        changed_attempt = asyncio.run(execution.execute_tool(
            request_id="req-task-scope", action="tasks.create", arguments=changed,
        ))
        self.assertEqual(changed_attempt["state"], "approval_required")
        self.assertNotEqual(first["approval"]["scope_hash"], changed_attempt["approval"]["scope_hash"])
        self.assertEqual(task_service.list_items(include_completed=True), [])


if __name__ == "__main__":
    unittest.main()

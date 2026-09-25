import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import config, db, inbox_api, mutation_tool_planner, orchestrator, task_service


class MutationToolPlannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.core_path = str(base / "core.sqlite3")
        self.patch_db = patch.object(db, "settings", replace(db.settings, sqlite_path=self.core_path))
        self.patch_inbox = patch.object(inbox_api, "INBOX_DB", str(base / "inbox.sqlite3"))
        self.patch_db.start()
        self.patch_inbox.start()
        db.initialise()
        inbox_api.initialise()

    def tearDown(self):
        self.patch_inbox.stop()
        self.patch_db.stop()
        self.temp.cleanup()

    def test_explicit_task_and_reminder_are_planned_without_invented_fields(self):
        task = mutation_tool_planner.plan_mutation_tool("Add task: renew passport")
        self.assertEqual(task.action, "tasks.create")
        self.assertEqual(task.arguments, {
            "kind": "task", "title": "renew passport", "due": None, "detail": "",
        })

        reminder = mutation_tool_planner.plan_mutation_tool(
            "Create reminder: pay insurance due 2026-10-14"
        )
        self.assertEqual(reminder.action, "tasks.create")
        self.assertEqual(reminder.arguments["kind"], "reminder")
        self.assertEqual(reminder.arguments["due"], "2026-10-14")

    def test_calendar_event_requires_explicit_start_and_end(self):
        incomplete = mutation_tool_planner.plan_mutation_tool(
            "Add calendar event: Dentist tomorrow at 10"
        )
        self.assertIsNone(incomplete)

        complete = mutation_tool_planner.plan_mutation_tool(
            "Add calendar event: Dentist from 2026-10-01T10:00+01:00 to 2026-10-01T10:30+01:00"
        )
        self.assertEqual(complete.action, "calendar.events.create")
        self.assertEqual(complete.arguments["summary"], "Dentist")
        self.assertEqual(complete.arguments["start"], "2026-10-01T10:00+01:00")
        self.assertEqual(complete.arguments["end"], "2026-10-01T10:30+01:00")

    def test_home_assistant_mutation_requires_explicit_supported_entity(self):
        plan = mutation_tool_planner.plan_mutation_tool("Turn on light.study")
        self.assertEqual(plan.action, "home_assistant.service")
        self.assertEqual(plan.arguments, {
            "service": "light.turn_on",
            "entity_id": "light.study",
        })
        self.assertIsNone(mutation_tool_planner.plan_mutation_tool("Turn on the study light"))
        self.assertIsNone(mutation_tool_planner.plan_mutation_tool("Turn on lock.front_door"))

    def test_task_request_creates_approval_but_never_executes_automatically(self):
        result = asyncio.run(orchestrator.orchestrate(
            channel="web",
            message="Add task: renew passport",
            conversation_id="mutation-task",
        ))
        self.assertEqual(result["decision"], "approval_required")
        self.assertEqual(result["tool_action"], "tasks.create")
        self.assertEqual(result["integration"], "alfred_tasks")
        self.assertEqual(result["approval"]["state"], "pending")
        with db.connection() as connection:
            approvals = connection.execute(
                "SELECT COUNT(*) FROM approvals WHERE request_id = ? AND state = 'pending'",
                (result["request_id"],),
            ).fetchone()[0]
            execution_table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_executions'"
            ).fetchone()
            executions = 0 if execution_table is None else connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE request_id = ?",
                (result["request_id"],),
            ).fetchone()[0]
        self.assertEqual(approvals, 1)
        self.assertEqual(executions, 0)
        self.assertEqual(task_service.list_items(kind="task", include_completed=False), [])

    def test_calendar_write_gate_denies_conversational_mutation_before_approval(self):
        configured_read_only = replace(
            config.settings,
            google_client_id="client",
            google_client_secret="secret",
            google_refresh_token="refresh",
            google_calendar_id="primary",
            google_calendar_write_enabled=False,
        )
        with patch.object(config, "settings", configured_read_only):
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message=(
                    "Add calendar event: Dentist from 2026-10-01T10:00+01:00 "
                    "to 2026-10-01T10:30+01:00"
                ),
            ))
        self.assertEqual(result["decision"], "denied")
        self.assertIn("write capability is disabled", result["reason"])
        with db.connection() as connection:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM approvals WHERE request_id = ?", (result["request_id"],)
            ).fetchone()[0], 0)

    def test_calendar_write_enabled_still_only_proposes_approval(self):
        configured_write = replace(
            config.settings,
            google_client_id="client",
            google_client_secret="secret",
            google_refresh_token="refresh",
            google_calendar_id="primary",
            google_calendar_write_enabled=True,
        )
        with (
            patch.object(config, "settings", configured_write),
            patch.object(orchestrator, "execute_cloud_request", new=AsyncMock(side_effect=AssertionError("cloud should not run"))),
        ):
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message=(
                    "Create event: Dentist from 2026-10-01T10:00+01:00 "
                    "to 2026-10-01T10:30+01:00"
                ),
            ))
        self.assertEqual(result["decision"], "approval_required")
        self.assertEqual(result["tool_action"], "calendar.events.create")
        self.assertEqual(result["approval"]["risk_level"], "external")

    def test_ambiguous_mutation_falls_through_without_creating_approval(self):
        with patch.object(orchestrator, "ollama_chat", new=AsyncMock(return_value="Please specify the exact details.")):
            result = asyncio.run(orchestrator.orchestrate(
                channel="web",
                message="Add something to my calendar tomorrow",
            ))
        self.assertNotEqual(result["decision"], "approval_required")
        with db.connection() as connection:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM approvals WHERE request_id = ?", (result["request_id"],)
            ).fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()

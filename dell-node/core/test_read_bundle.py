import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import db, inbox_api, orchestrator, read_bundle
from app.read_tool_planner import ReadToolPlan


class ReadBundleTests(unittest.TestCase):
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

    def test_calendar_and_reminders_form_two_safe_read_steps(self):
        plans = read_bundle.plan_read_tools("Show my calendar tomorrow and my reminders")
        self.assertEqual([plan.action for plan in plans], ["calendar.events.list", "tasks.list"])
        self.assertEqual(plans[1].arguments["kind"], "reminder")

    def test_mutation_or_ambiguous_clause_cannot_become_bundle(self):
        self.assertEqual(
            read_bundle.plan_read_tools("Show my calendar tomorrow and add task: renew passport"),
            [],
        )
        # The original single file query should remain a single-tool concern;
        # the word 'and' inside its search text must not create a partial bundle.
        self.assertEqual(
            read_bundle.plan_read_tools("Search my files for budget and forecast"),
            [],
        )

    def test_preflight_unavailable_blocks_all_execution(self):
        plans = [
            ReadToolPlan("tasks.list", {"include_completed": False, "limit": 50}, "alfred_tasks", "tasks"),
            ReadToolPlan(
                "calendar.events.list",
                {"start": "2026-09-26T00:00:00+01:00", "end": "2026-09-27T00:00:00+01:00", "limit": 20},
                "google_calendar",
                "calendar",
            ),
        ]
        with (
            patch.object(read_bundle, "action_available", side_effect=[(True, None), (False, "Google Calendar is not configured.")]),
            patch.object(read_bundle, "execute_tool", new=AsyncMock(side_effect=AssertionError("no step should execute"))),
        ):
            result = asyncio.run(read_bundle.execute_read_bundle(request_id="req-preflight", plans=plans))
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["steps"], [])

    def test_bundle_executes_sequentially_and_aggregates_with_provenance(self):
        plans = [
            ReadToolPlan("tasks.list", {"kind": "reminder", "include_completed": False, "limit": 50}, "alfred_tasks", "tasks"),
            ReadToolPlan(
                "home_assistant.state",
                {"entity_id": "light.study"},
                "home_assistant",
                "home",
            ),
        ]
        executions = [
            {
                "id": "exec-1",
                "state": "completed",
                "verification": {"ok": True},
                "result": {"items": [{"source_id": "r1", "kind": "reminder", "title": "Bins", "due": "2026-09-26", "detail": "", "completed": False}]},
            },
            {
                "id": "exec-2",
                "state": "completed",
                "verification": {"ok": True},
                "result": {"ok": True, "entity_id": "light.study", "state": "off", "attributes": {}},
            },
        ]
        execute = AsyncMock(side_effect=executions)
        with (
            patch.object(read_bundle, "action_available", return_value=(True, None)),
            patch.object(read_bundle, "execute_tool", new=execute),
        ):
            result = asyncio.run(read_bundle.execute_read_bundle(request_id="req-bundle", plans=plans))

        self.assertEqual(result["state"], "completed")
        self.assertIn("Tasks:", result["reply"])
        self.assertIn("Home Assistant:", result["reply"])
        self.assertEqual(len(result["steps"]), 2)
        self.assertEqual(len(result["sources"]), 2)
        self.assertEqual(result["sources"][0]["integration"], "alfred_tasks")
        self.assertEqual(execute.await_args_list[0].kwargs["step_index"], 0)
        self.assertEqual(execute.await_args_list[1].kwargs["step_index"], 1)
        self.assertEqual(
            execute.await_args_list[0].kwargs["plan_id"],
            execute.await_args_list[1].kwargs["plan_id"],
        )

    def test_orchestrator_uses_bundle_without_ollama_or_cloud(self):
        plans = [
            ReadToolPlan("tasks.list", {"include_completed": False, "limit": 50}, "alfred_tasks", "tasks"),
            ReadToolPlan("home_assistant.state", {"entity_id": "light.study"}, "home_assistant", "home"),
        ]
        bundle_result = {
            "state": "completed",
            "reply": "Tasks: one item\nHome Assistant: light.study is off.",
            "sources": [
                {"action": "tasks.list", "integration": "alfred_tasks", "source": {"title": "One"}},
                {"action": "home_assistant.state", "integration": "home_assistant", "source": {"entity_id": "light.study", "state": "off"}},
            ],
            "steps": [{"index": 0}, {"index": 1}],
            "actions": ["tasks.list", "home_assistant.state"],
            "integrations": ["alfred_tasks", "home_assistant"],
        }
        with (
            patch.object(orchestrator, "plan_read_tools", return_value=plans),
            patch.object(orchestrator, "execute_read_bundle", new=AsyncMock(return_value=bundle_result)),
            patch.object(orchestrator, "ollama_chat", new=AsyncMock(side_effect=AssertionError("ollama chat should not run"))),
            patch.object(orchestrator, "ollama_route", new=AsyncMock(side_effect=AssertionError("ollama route should not run"))),
            patch.object(orchestrator, "execute_cloud_request", new=AsyncMock(side_effect=AssertionError("cloud should not run"))),
        ):
            result = asyncio.run(orchestrator.orchestrate(
                channel="web",
                message="Show my reminders and status of light.study",
                conversation_id="bundle-conversation",
            ))
        self.assertEqual(result["decision"], "tool")
        self.assertEqual(result["provider"], "integration:multi")
        self.assertEqual(result["tool_action"], "multi_read")
        self.assertEqual(result["integration"], "multiple")
        self.assertEqual(len(result["sources"]), 2)


if __name__ == "__main__":
    unittest.main()

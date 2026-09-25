import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import (
    agent_loop,
    approval_engine,
    db,
    execution,
    goals,
    proactive,
    recovery,
    task_service,
    workflows,
)


class ApprovalEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.db_path = str(base / "core.sqlite3")
        self.patch_db_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.patch_db_settings.start()
        db.initialise()
        execution.initialise_execution_store()
        recovery.initialise_recovery_store()
        task_service.initialise()
        goals.initialise()
        agent_loop.initialise()
        workflows.initialise()
        approval_engine.initialise()

    def tearDown(self):
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_goal_write_gets_content_minimised_context_without_changing_scope(self):
        created = goals.create_goal(
            goal="Create a private task title that must not be copied to approval context",
            steps=[
                {
                    "action": "tasks.create",
                    "arguments": {"kind": "task", "title": "PRIVATE TASK TITLE"},
                }
            ],
            request_id="req-approval-context",
        )

        result = asyncio.run(agent_loop.run_goal(created["id"]))
        self.assertEqual(result["state"], "awaiting_approval")
        approval = result["steps"][0]["approval"]
        context = approval_engine.get_context(approval["id"])
        self.assertIsNotNone(context)
        self.assertEqual(context["goal_id"], created["id"])
        self.assertEqual(context["step_position"], 0)
        self.assertEqual(context["step_count"], 1)
        self.assertEqual(context["risk_level"], "safe_write")
        self.assertEqual(context["effect"], "create_local_task")

        with db.connection() as connection:
            stored_approval = connection.execute(
                "SELECT scope_hash FROM approvals WHERE id = ?", (approval["id"],)
            ).fetchone()
        self.assertIsNotNone(stored_approval)
        expected_scope = execution._scope_hash(
            "tasks.create",
            {"kind": "task", "title": "PRIVATE TASK TITLE"},
            created["plan_id"],
            0,
        )
        self.assertEqual(stored_approval["scope_hash"], expected_scope)
        self.assertEqual(context["scope_hash"], expected_scope)

        encoded = json.dumps(context)
        self.assertNotIn("PRIVATE TASK TITLE", encoded)
        self.assertNotIn("private task title", encoded.lower())
        self.assertFalse(context["raw_arguments_stored"])
        self.assertFalse(context["bound_values_stored"])

    def test_workflow_context_counts_only_verified_dependencies_and_bindings(self):
        db.remember("note", "Book boiler service", "test")
        created = workflows.create_workflow(
            goal="Turn verified context into a task",
            steps=[
                {"action": "memory.read", "arguments": {"query": "boiler service"}},
                {
                    "action": "tasks.create",
                    "arguments": {"kind": "task"},
                    "depends_on": [0],
                    "bindings": [
                        {"target": "title", "source_step": 0, "source_path": "items.0.content"}
                    ],
                },
            ],
            request_id="req-approval-workflow",
        )
        goal = created["goal"]

        waiting = asyncio.run(agent_loop.run_goal(goal["id"]))
        self.assertEqual(waiting["state"], "awaiting_approval")
        approval = waiting["steps"][-1]["approval"]
        context = approval_engine.get_context(approval["id"])
        self.assertIsNotNone(context)
        self.assertEqual(context["dependency_count"], 1)
        self.assertEqual(context["verified_dependency_count"], 1)
        self.assertEqual(context["binding_count"], 1)
        self.assertIn("verified prerequisite", context["why"])
        self.assertIn("verified scalar hand-off", context["why"])
        self.assertNotIn("Book boiler service", json.dumps(context))

    def test_non_goal_approval_does_not_create_goal_context(self):
        result = asyncio.run(execution.execute_tool(
            request_id="req-plain-write",
            action="memory.write",
            arguments={"kind": "note", "content": "plain private value"},
        ))
        self.assertEqual(result["state"], "approval_required")
        self.assertIsNone(approval_engine.get_context(result["approval"]["id"]))
        self.assertEqual(approval_engine.status()["contexts"], 0)

    def test_status_and_routes_are_content_minimised(self):
        state = approval_engine.status()
        self.assertEqual(state["mode"], "goal_aware_exact_scope_v1")
        self.assertEqual(state["risk_source"], "core_tools_deterministic")
        self.assertEqual(state["approval_scope"], "existing_sha256_exact_arguments")
        self.assertEqual(state["goal_context"], "metadata_only")
        self.assertFalse(state["raw_arguments_stored"])
        self.assertFalse(state["bound_values_stored"])
        self.assertFalse(state["policy_changes"])
        self.assertFalse(state["cloud_models"])

        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/approval-engine/status", paths)
        self.assertIn("/v1/core/approval-engine/pending", paths)
        self.assertIn("/v1/core/approvals/{approval_id}/context", paths)

    def test_effect_classification_is_generic_and_deterministic(self):
        self.assertEqual(approval_engine._effect_for("tasks.create"), "create_local_task")
        self.assertEqual(
            approval_engine._effect_for("calendar.events.create"),
            "create_external_calendar_event",
        )
        self.assertEqual(
            approval_engine._effect_for("email.draft.create"),
            "create_external_email_draft",
        )
        self.assertEqual(
            approval_engine._effect_for("home_assistant.service"),
            "change_device_state",
        )


if __name__ == "__main__":
    unittest.main()

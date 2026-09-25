import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import agent_loop, approval_resume, db, execution, goals, proactive, recovery, task_service, workflows


class WorkflowTests(unittest.TestCase):
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

    def tearDown(self):
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_workflow_requires_explicit_verified_dependency_binding(self):
        valid_steps, bindings = workflows._validate_workflow_steps([
            {"action": "memory.read", "arguments": {"query": "fixture"}},
            {
                "action": "tasks.create",
                "arguments": {"kind": "task"},
                "depends_on": [0],
                "bindings": [{"target": "title", "source_step": 0, "source_path": "items.0.content"}],
            },
        ])
        self.assertEqual(len(valid_steps), 2)
        self.assertEqual(bindings[0]["source_step"], 0)

        with self.assertRaises(ValueError):
            workflows._validate_workflow_steps([
                {"action": "memory.read", "arguments": {"query": "fixture"}},
                {
                    "action": "tasks.create",
                    "arguments": {"kind": "task"},
                    "depends_on": [],
                    "bindings": [{"target": "title", "source_step": 0, "source_path": "items.0.content"}],
                },
            ])

        with self.assertRaises(ValueError):
            workflows._validate_workflow_steps([
                {"action": "memory.read", "arguments": {"query": "fixture"}},
                {
                    "action": "tasks.create",
                    "arguments": {"kind": "task", "title": "literal"},
                    "depends_on": [0],
                    "bindings": [{"target": "title", "source_step": 0, "source_path": "items.0.content"}],
                },
            ])

    def test_binding_uses_only_verified_completed_source_result(self):
        created = workflows.create_workflow(
            goal="Carry verified value",
            steps=[
                {"action": "memory.read", "arguments": {"query": "fixture"}},
                {
                    "action": "tasks.create",
                    "arguments": {"kind": "task"},
                    "depends_on": [0],
                    "bindings": [{"target": "title", "source_step": 0, "source_path": "items.0.content"}],
                },
            ],
            request_id="req-workflow-verified",
        )
        goal = created["goal"]
        with db.connection() as connection:
            connection.execute(
                """INSERT INTO core_executions
                   (id, request_id, plan_id, step_index, action, state, arguments, result, verification, completed_at)
                   VALUES ('source-complete', ?, ?, 0, 'memory.read', 'completed', '{}', ?, ?, CURRENT_TIMESTAMP)""",
                (
                    goal["request_id"], goal["plan_id"],
                    json.dumps({"items": [{"content": "Verified task title"}]}),
                    json.dumps({"ok": True, "method": "read_result"}),
                ),
            )
        refreshed = goals.sync_goal_progress(goal["id"])
        target_step = refreshed["steps"][1]
        resolved, count = workflows.resolve_step_arguments(refreshed, target_step)
        self.assertEqual(count, 1)
        self.assertEqual(resolved, {"kind": "task", "title": "Verified task title"})

        with db.connection() as connection:
            connection.execute(
                "UPDATE core_executions SET verification = ? WHERE id = 'source-complete'",
                (json.dumps({"ok": False}),),
            )
        with self.assertRaises(workflows.WorkflowBindingError):
            workflows.resolve_step_arguments(refreshed, target_step)

    def test_structured_or_oversized_values_are_not_transferable(self):
        with self.assertRaises(workflows.WorkflowBindingError):
            workflows._extract_scalar({"items": [{"content": "x"}]}, "items.0")
        with self.assertRaises(workflows.WorkflowBindingError):
            workflows._extract_scalar({"value": "x" * (workflows.MAX_BOUND_STRING_CHARS + 1)}, "value")

    def test_multi_tool_run_resolves_before_exact_scope_approval_and_resumes(self):
        db.remember("note", "Book boiler service", "test")
        created = workflows.create_workflow(
            goal="Turn local context into a task",
            steps=[
                {"action": "memory.read", "arguments": {"query": "boiler service"}},
                {
                    "action": "tasks.create",
                    "arguments": {"kind": "task"},
                    "depends_on": [0],
                    "bindings": [{"target": "title", "source_step": 0, "source_path": "items.0.content"}],
                },
            ],
            request_id="req-workflow-run",
        )
        goal = created["goal"]

        waiting = asyncio.run(agent_loop.run_goal(goal["id"]))
        self.assertEqual(waiting["state"], "awaiting_approval")
        approval_id = waiting["steps"][-1]["approval"]["id"]
        expected_arguments = {"kind": "task", "title": "Book boiler service"}
        with db.connection() as connection:
            approval = connection.execute(
                "SELECT scope_hash FROM approvals WHERE id = ?", (approval_id,)
            ).fetchone()
        self.assertIsNotNone(approval)
        self.assertEqual(
            approval["scope_hash"],
            execution._scope_hash("tasks.create", expected_arguments, goal["plan_id"], 1),
        )

        resumed = asyncio.run(approval_resume.resolve_and_resume(approval_id, True))
        self.assertTrue(resumed["goal"]["continued"])
        self.assertEqual(resumed["goal"]["state"], "completed")
        items = task_service.list_items(kind="task", include_completed=True, limit=20)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "Book boiler service")

        with db.connection() as connection:
            source_runs = connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE plan_id = ? AND step_index = 0",
                (goal["plan_id"],),
            ).fetchone()[0]
            target_runs = connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE plan_id = ? AND step_index = 1",
                (goal["plan_id"],),
            ).fetchone()[0]
        self.assertEqual(source_runs, 1)
        self.assertEqual(target_runs, 1)

    def test_binding_failure_blocks_without_calling_mutation(self):
        created = workflows.create_workflow(
            goal="Missing source value",
            steps=[
                {"action": "memory.read", "arguments": {"query": "nothing"}},
                {
                    "action": "tasks.create",
                    "arguments": {"kind": "task"},
                    "depends_on": [0],
                    "bindings": [{"target": "title", "source_step": 0, "source_path": "items.0.content"}],
                },
            ],
            request_id="req-workflow-missing",
        )
        result = asyncio.run(agent_loop.run_goal(created["goal"]["id"]))
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(result["stop_reason"], "step_failed_or_denied")
        self.assertEqual(task_service.list_items(kind="task", include_completed=True, limit=20), [])

    def test_status_is_content_minimised_and_routes_are_authenticated_collection(self):
        secret = "PRIVATE WORKFLOW VALUE"
        workflows.create_workflow(
            goal=secret,
            steps=[{"action": "memory.read", "arguments": {"query": secret}}],
            request_id="req-workflow-status",
        )
        state = workflows.status()
        encoded = json.dumps(state)
        self.assertNotIn(secret, encoded)
        self.assertEqual(state["mode"], "verified_multi_tool_workflows_v1")
        self.assertEqual(state["handoff"], "verified_scalar_only")
        self.assertEqual(state["mutation_approval"], "fully_resolved_exact_scope")
        self.assertFalse(state["automatic_planning"])
        self.assertFalse(state["code_evaluation"])
        self.assertFalse(state["cloud_models"])

        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/workflows/status", paths)
        self.assertIn("/v1/core/workflows", paths)
        self.assertIn("/v1/core/workflows/{workflow_id}", paths)


if __name__ == "__main__":
    unittest.main()

import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, execution, goals, proactive, recovery


class DurableGoalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.patch_db_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.patch_db_settings.start()
        db.initialise()
        execution.initialise_execution_store()
        recovery.initialise_recovery_store()
        goals.initialise()

    def tearDown(self):
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_create_goal_persists_stable_steps_and_dependencies(self):
        created = goals.create_goal(
            goal="Prepare tomorrow",
            steps=[
                {"action": "tasks.list", "arguments": {"limit": 10}},
                {"action": "calendar.events.list", "arguments": {"time_min": "2099-01-01T00:00:00Z", "time_max": "2099-01-02T00:00:00Z"}, "depends_on": [0]},
            ],
            request_id="req-goal-create",
        )

        self.assertEqual(created["state"], "ready")
        self.assertEqual(len(created["steps"]), 2)
        first, second = created["steps"]
        self.assertEqual(first["state"], "ready")
        self.assertEqual(second["state"], "pending")
        self.assertEqual(second["depends_on"], [first["id"]])
        self.assertEqual(created["current_step_id"], first["id"])

        with db.connection() as connection:
            plan = connection.execute("SELECT id, request_id, state, steps FROM plans WHERE id = ?", (created["plan_id"],)).fetchone()
        self.assertIsNotNone(plan)
        self.assertEqual(plan["request_id"], "req-goal-create")
        self.assertEqual(plan["state"], "draft")
        encoded_steps = json.loads(plan["steps"])
        self.assertEqual(encoded_steps[0]["goal_step_id"], first["id"])
        self.assertEqual(encoded_steps[1]["depends_on"], [first["id"]])

    def test_invalid_dependency_and_unregistered_action_fail_closed(self):
        with self.assertRaises(ValueError):
            goals.create_goal(
                goal="Broken dependency",
                steps=[{"action": "memory.read", "arguments": {"query": "x"}, "depends_on": [0]}],
            )
        with self.assertRaises(ValueError):
            goals.create_goal(
                goal="Unknown tool",
                steps=[{"action": "browser.buy.now", "arguments": {}}],
            )
        self.assertEqual(goals.status()["goals"], 0)

    def test_progress_is_reconstructed_from_existing_executor_state(self):
        created = goals.create_goal(
            goal="Read then save",
            steps=[
                {"action": "memory.read", "arguments": {"query": "anything"}},
                {"action": "memory.write", "arguments": {"kind": "note", "content": "Local durable note"}, "depends_on": [0]},
            ],
            request_id="req-goal-progress",
        )

        first = asyncio.run(execution.execute_tool(
            request_id=created["request_id"],
            plan_id=created["plan_id"],
            step_index=0,
            action="memory.read",
            arguments={"query": "anything"},
        ))
        self.assertEqual(first["state"], "completed")

        second = asyncio.run(execution.execute_tool(
            request_id=created["request_id"],
            plan_id=created["plan_id"],
            step_index=1,
            action="memory.write",
            arguments={"kind": "note", "content": "Local durable note"},
        ))
        self.assertEqual(second["state"], "approval_required")

        refreshed = goals.sync_goal_progress(created["id"])
        self.assertEqual(refreshed["state"], "awaiting_approval")
        self.assertEqual(refreshed["steps"][0]["state"], "completed")
        self.assertEqual(refreshed["steps"][1]["state"], "awaiting_approval")
        self.assertEqual(refreshed["current_step_id"], refreshed["steps"][1]["id"])

    def test_cancelled_goal_cannot_run_underlying_plan(self):
        created = goals.create_goal(
            goal="Save something later",
            steps=[{"action": "memory.write", "arguments": {"kind": "note", "content": "Must never run"}}],
            request_id="req-goal-cancel",
        )
        cancelled = goals.cancel_goal(created["id"])
        self.assertEqual(cancelled["state"], "cancelled")

        result = asyncio.run(execution.execute_plan(created["plan_id"]))
        self.assertEqual(result["state"], "cancelled")
        self.assertEqual(result["executions"], [])
        self.assertEqual(db.list_memories(), [])

    def test_restart_recovery_reconciles_interrupted_goal(self):
        created = goals.create_goal(
            goal="Recover after restart",
            steps=[{"action": "memory.read", "arguments": {"query": "saved state"}}],
            request_id="req-goal-restart",
        )
        with db.connection() as connection:
            connection.execute("UPDATE plans SET state = 'running' WHERE id = ?", (created["plan_id"],))
            connection.execute(
                """INSERT INTO core_executions
                   (id, request_id, plan_id, step_index, action, state, arguments)
                   VALUES ('running-goal-step', ?, ?, 0, 'memory.read', 'running', ?)""",
                (created["request_id"], created["plan_id"], json.dumps({"query": "saved state"})),
            )

        recovered = recovery.recover_interrupted_work()
        self.assertEqual(recovered["executions"], 1)
        self.assertEqual(recovered["plans"], 1)
        self.assertEqual(recovered["goals"]["states"]["blocked"], 1)
        self.assertEqual(goals.get_goal(created["id"])["state"], "blocked")

    def test_status_is_content_minimised_and_declares_no_auto_execution(self):
        secret = "PRIVATE GOAL CONTENT MUST NOT APPEAR IN STATUS"
        goals.create_goal(
            goal=secret,
            steps=[{"action": "memory.read", "arguments": {"query": "private query"}}],
        )
        state = goals.status()
        encoded = json.dumps(state)
        self.assertNotIn(secret, encoded)
        self.assertNotIn("private query", encoded)
        self.assertEqual(state["mode"], "durable_goals_v1")
        self.assertTrue(state["durable"])
        self.assertFalse(state["automatic_execution"])
        self.assertFalse(state["cloud_models"])

    def test_goal_routes_share_authenticated_core_route_collection(self):
        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/goals", paths)
        self.assertIn("/v1/core/goals/status", paths)
        self.assertIn("/v1/core/goals/{goal_id}", paths)
        self.assertIn("/v1/core/goals/{goal_id}/cancel", paths)


if __name__ == "__main__":
    unittest.main()

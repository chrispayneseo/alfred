import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import agent_loop, approval_resume, db, execution, goals, proactive, recovery


class AgentLoopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.patch_db_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.patch_db_settings.start()
        db.initialise()
        execution.initialise_execution_store()
        recovery.initialise_recovery_store()
        goals.initialise()
        agent_loop.initialise()

    def tearDown(self):
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_owner_started_loop_completes_safe_read_chain(self):
        db.remember("note", "Tomorrow prep checklist", "test")
        created = goals.create_goal(
            goal="Prepare context",
            steps=[
                {"action": "memory.read", "arguments": {"query": "tomorrow prep"}},
                {"action": "memory.read", "arguments": {"query": "checklist"}, "depends_on": [0]},
            ],
            request_id="req-loop-read",
        )

        result = asyncio.run(agent_loop.run_goal(created["id"]))
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["stop_reason"], "goal_completed")
        self.assertEqual(len(result["steps"]), 2)
        self.assertTrue(all(step["verified"] for step in result["steps"]))
        self.assertEqual(goals.get_goal(created["id"])["state"], "completed")

    def test_loop_stops_at_write_approval_without_mutating(self):
        created = goals.create_goal(
            goal="Read then save",
            steps=[
                {"action": "memory.read", "arguments": {"query": "nothing"}},
                {
                    "action": "memory.write",
                    "arguments": {"kind": "note", "content": "Approved later"},
                    "depends_on": [0],
                },
            ],
            request_id="req-loop-approval",
        )

        result = asyncio.run(agent_loop.run_goal(created["id"]))
        self.assertEqual(result["state"], "awaiting_approval")
        self.assertEqual(result["stop_reason"], "approval_required")
        self.assertEqual(len(result["steps"]), 2)
        self.assertEqual(result["steps"][-1]["state"], "approval_required")
        self.assertEqual(db.list_memories(), [])
        self.assertEqual(goals.get_goal(created["id"])["state"], "awaiting_approval")

    def test_approved_goal_step_resumes_and_does_not_replay_completed_read(self):
        created = goals.create_goal(
            goal="Read then save",
            steps=[
                {"action": "memory.read", "arguments": {"query": "anything"}},
                {
                    "action": "memory.write",
                    "arguments": {"kind": "note", "content": "Durable approved note"},
                    "depends_on": [0],
                },
            ],
            request_id="req-loop-resume",
        )
        waiting = asyncio.run(agent_loop.run_goal(created["id"]))
        approval_id = waiting["steps"][-1]["approval"]["id"]

        resumed = asyncio.run(approval_resume.resolve_and_resume(approval_id, True))
        self.assertEqual(resumed["state"], "approved")
        self.assertTrue(resumed["goal"]["continued"])
        self.assertEqual(resumed["goal"]["state"], "completed")
        self.assertEqual(len(db.list_memories()), 1)

        with db.connection() as connection:
            read_count = connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE plan_id = ? AND step_index = 0",
                (created["plan_id"],),
            ).fetchone()[0]
            write_count = connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE plan_id = ? AND step_index = 1",
                (created["plan_id"],),
            ).fetchone()[0]
        self.assertEqual(read_count, 1)
        self.assertEqual(write_count, 1)

    def test_rejected_goal_approval_blocks_without_execution(self):
        created = goals.create_goal(
            goal="Save only with approval",
            steps=[{"action": "memory.write", "arguments": {"kind": "note", "content": "Never save"}}],
            request_id="req-loop-reject",
        )
        waiting = asyncio.run(agent_loop.run_goal(created["id"]))
        approval_id = waiting["steps"][0]["approval"]["id"]

        rejected = asyncio.run(approval_resume.resolve_and_resume(approval_id, False))
        self.assertEqual(rejected["state"], "rejected")
        self.assertFalse(rejected["goal"]["continued"])
        self.assertEqual(rejected["goal"]["state"], "blocked")
        self.assertEqual(db.list_memories(), [])

    def test_existing_running_lease_prevents_parallel_loop(self):
        created = goals.create_goal(
            goal="Read once",
            steps=[{"action": "memory.read", "arguments": {"query": "safe"}}],
            request_id="req-loop-lock",
        )
        run_id, existing = agent_loop._begin_run(created, "test")
        self.assertIsNotNone(run_id)
        self.assertIsNone(existing)

        second = asyncio.run(agent_loop.run_goal(created["id"]))
        self.assertEqual(second["state"], "running")
        self.assertEqual(second["stop_reason"], "already_running")
        with db.connection() as connection:
            executions = connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE plan_id = ?", (created["plan_id"],)
            ).fetchone()[0]
        self.assertEqual(executions, 0)

    def test_restart_closes_stale_run_without_auto_replay(self):
        created = goals.create_goal(
            goal="Survive restart",
            steps=[{"action": "memory.read", "arguments": {"query": "safe"}}],
            request_id="req-loop-restart",
        )
        run_id, _ = agent_loop._begin_run(created, "test")
        self.assertIsNotNone(run_id)

        recovered = recovery.recover_interrupted_work()
        self.assertEqual(recovered, {"executions": 0, "plans": 0})
        with db.connection() as connection:
            state = connection.execute(
                "SELECT state FROM agent_goal_runs WHERE id = ?", (run_id,)
            ).fetchone()[0]
            executions = connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE plan_id = ?", (created["plan_id"],)
            ).fetchone()[0]
        self.assertEqual(state, "interrupted")
        self.assertEqual(executions, 0)

    def test_status_is_content_minimised_and_explicit_about_autonomy_boundary(self):
        state = agent_loop.status()
        self.assertEqual(state["mode"], "bounded_agent_loop_v1")
        self.assertFalse(state["automatic_start"])
        self.assertTrue(state["automatic_safe_continuation"])
        self.assertTrue(state["approval_resume"])
        self.assertEqual(state["approval_policy"], "existing_exact_scope")
        self.assertFalse(state["adds_or_replans_steps"])
        self.assertFalse(state["cloud_models"])
        self.assertFalse(state["restart_auto_replay"])

    def test_routes_share_existing_authenticated_core_route_collection(self):
        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/agent-loop/status", paths)
        self.assertIn("/v1/core/goals/{goal_id}/run", paths)


if __name__ == "__main__":
    unittest.main()

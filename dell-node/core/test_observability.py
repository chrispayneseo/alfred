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
    execution_reliability,
    goals,
    observability,
    proactive,
    recovery,
    reusable_workflows,
    task_service,
    workflows,
)


class ObservabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.db_path = str(base / "core.sqlite3")
        self.patch_db_settings = patch.object(
            db, "settings", replace(db.settings, sqlite_path=self.db_path)
        )
        self.patch_db_settings.start()
        db.initialise()
        execution.initialise_execution_store()
        recovery.initialise_recovery_store()
        execution_reliability.initialise()
        task_service.initialise()
        goals.initialise()
        agent_loop.initialise()
        workflows.initialise()
        approval_engine.initialise()
        reusable_workflows.initialise()

    def tearDown(self):
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_status_is_read_only_content_minimised_and_authenticated(self):
        state = observability.status()
        self.assertEqual(state["mode"], "agent_observability_v1")
        self.assertEqual(state["content_policy"], "metadata_only")
        self.assertTrue(state["read_only"])
        self.assertTrue(state["today_view"])
        self.assertTrue(state["deterministic_explanations"])
        self.assertFalse(state["connected_content_exposed"])
        self.assertFalse(state["raw_arguments_exposed"])
        self.assertFalse(state["tool_results_exposed"])
        self.assertFalse(state["recipe_parameters_exposed"])
        self.assertFalse(state["scope_hashes_exposed"])
        self.assertFalse(state["mutations"])
        self.assertFalse(state["cloud_models"])

        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/observability/status", paths)
        self.assertIn("/v1/core/observability/today", paths)

    def test_waiting_approval_explains_recipe_without_parameter_content(self):
        secret_title = "PRIVATE CLIENT TASK CONTENT 7f913"
        created = reusable_workflows.instantiate_recipe(
            "prepare_client_task",
            parameters={"title": secret_title, "detail": "secret detail", "due": None},
            request_id="req-observe-approval",
        )
        run = asyncio.run(agent_loop.run_goal(created["goal_id"]))
        self.assertEqual(run["state"], "awaiting_approval")

        view = observability.today_view()
        encoded = json.dumps(view)
        self.assertNotIn(secret_title, encoded)
        self.assertNotIn("secret detail", encoded)
        self.assertEqual(view["counts"]["waiting_approvals"], 1)
        self.assertEqual(len(view["waiting_approvals"]), 1)
        approval = view["waiting_approvals"][0]
        self.assertNotIn("scope_hash", approval)
        self.assertEqual(approval["action"], "tasks.create")
        self.assertEqual(approval["effect"], "create_local_task")
        self.assertEqual(approval["recipe"]["id"], "prepare_client_task")
        self.assertIn("approval-gated", approval["why"])

        active = next(item for item in view["active_goals"] if item["goal_id"] == created["goal_id"])
        self.assertEqual(active["state"], "awaiting_approval")
        self.assertEqual(active["current_step"]["action"], "tasks.create")
        self.assertEqual(active["current_step"]["approval"]["id"], approval["approval_id"])
        self.assertIn("owner approval", active["current_step"]["why"])

    def test_verified_completed_work_exposes_receipt_metadata_not_results(self):
        private_query = "PRIVATE MEMORY QUERY 31ad"
        created = goals.create_goal(
            goal="Private goal label that must not appear",
            steps=[{"action": "memory.read", "arguments": {"query": private_query}}],
            request_id="req-observe-complete",
        )
        result = asyncio.run(agent_loop.run_goal(created["id"]))
        self.assertEqual(result["state"], "completed")

        view = observability.today_view()
        encoded = json.dumps(view)
        self.assertNotIn(private_query, encoded)
        self.assertNotIn("Private goal label", encoded)
        self.assertNotIn('"arguments"', encoded)
        self.assertNotIn('"result"', encoded)
        completed = [item for item in view["completed_work"] if item["action"] == "memory.read"]
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]["outcome"], "verified_completed")
        self.assertGreaterEqual(view["counts"]["completed_work_today"], 1)

    def test_today_payload_never_exposes_forbidden_content_fields(self):
        view = observability.today_view()

        forbidden = {
            "arguments", "result", "verification", "scope_hash", "parameter_hash",
            "goal", "message", "body", "content", "text", "query",
        }

        def walk(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    self.assertNotIn(key, forbidden)
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        walk(view)
        self.assertEqual(view["explanations"]["source"], "deterministic_metadata_v1")
        self.assertFalse(view["explanations"]["connected_content_exposed"])


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import db, operations, phase12_acceptance, projects


class Phase12ProjectTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch_settings = patch.object(
            db, "settings", replace(db.settings, sqlite_path=str(Path(self.temp.name) / "core.sqlite3"))
        )
        self.patch_settings.start()
        db.initialise()
        projects.initialise()

    def tearDown(self):
        self.patch_settings.stop()
        self.temp.cleanup()

    def test_project_creation_validates_operations_and_hides_parameter_values(self):
        with patch.object(operations, "preview", return_value={"will_mutate": False}) as preview:
            project = projects.create_project(
                title="House admin",
                milestones=[
                    {"title": "Research boiler", "operation_id": "research_purchase", "parameters": {"url": "https://example.com/boiler"}},
                    {"title": "Create service task", "operation_id": "prepare_home_task", "parameters": {"title": "Book service", "detail": "", "due": None}},
                ],
            )
        self.assertEqual(preview.call_count, 2)
        self.assertEqual(project["state"], "ready")
        self.assertEqual(len(project["milestones"]), 2)
        self.assertNotIn("parameters", project["milestones"][0])
        self.assertEqual(len(project["milestones"][0]["parameter_hash"]), 64)

    async def test_project_run_creates_only_one_goal_and_stops_at_approval(self):
        with patch.object(operations, "preview", return_value={"will_mutate": False}):
            project = projects.create_project(
                title="Client launch",
                milestones=[
                    {"title": "Task one", "operation_id": "prepare_client_task", "parameters": {"title": "First", "detail": "", "due": None}},
                    {"title": "Task two", "operation_id": "prepare_client_task", "parameters": {"title": "Second", "detail": "", "due": None}},
                ],
            )
        fake = {
            "result": {
                "instance": {"goal_id": "goal-one"},
                "run": {"state": "awaiting_approval"},
            }
        }
        with patch.object(operations, "run", new=AsyncMock(return_value=fake)) as run:
            result = await projects.run_project(project["id"])
        self.assertEqual(run.await_count, 1)
        self.assertEqual(result["milestones_started"], 1)
        self.assertEqual(result["stop_reason"], "awaiting_approval")
        current = projects.get_project(project["id"], sync=False)
        self.assertEqual(current["milestones"][0]["goal_id"], "goal-one")
        self.assertIsNone(current["milestones"][1]["goal_id"])

    def test_cancel_does_not_cancel_or_rewrite_existing_goal(self):
        with patch.object(operations, "preview", return_value={"will_mutate": False}):
            project = projects.create_project(
                title="Cancellation boundary",
                milestones=[{"title": "Pending", "operation_id": "prepare_client_task", "parameters": {"title": "Pending", "detail": "", "due": None}}],
            )
        cancelled = projects.cancel_project(project["id"])
        self.assertEqual(cancelled["state"], "cancelled")
        self.assertEqual(cancelled["milestones"][0]["state"], "cancelled")
        self.assertIsNone(cancelled["milestones"][0]["goal_id"])


class Phase12AcceptanceTests(unittest.TestCase):
    def test_contract_and_previous_phase_gate(self):
        safe = {
            "mode": projects.MODE, "max_milestones": 8, "milestones_per_run": 1,
            "operation_catalog_reused": True, "durable_goals_reused": True,
            "bounded_agent_loop_reused": True, "exact_scope_approval_reused": True,
            "verification_recovery_reused": True, "automatic_approval": False,
            "automatic_mutation_replay": False, "new_executor": False, "cloud_models": False,
        }
        with patch.object(phase12_acceptance.projects, "status", return_value=safe), patch.object(
            phase12_acceptance.phase11_acceptance, "acceptance_status",
            return_value={"accepted": True, "mode": "phase11_life_work_operations_acceptance_v1"},
        ):
            accepted = phase12_acceptance.acceptance_status()
        self.assertTrue(accepted["accepted"], accepted["failed_checks"])
        self.assertEqual(accepted["check_count"], 10)

        with patch.object(phase12_acceptance.projects, "status", return_value=safe), patch.object(
            phase12_acceptance.phase11_acceptance, "acceptance_status",
            return_value={"accepted": False, "mode": "phase11_life_work_operations_acceptance_v1"},
        ):
            failed = phase12_acceptance.acceptance_status()
        self.assertFalse(failed["accepted"])
        self.assertIn("phase11_baseline_preserved", failed["failed_checks"])


if __name__ == "__main__":
    unittest.main()

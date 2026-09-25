import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import (
    agent_loop,
    db,
    execution,
    goals,
    proactive,
    recovery,
    reusable_workflows,
    task_service,
    workflows,
)


class ReusableWorkflowTests(unittest.TestCase):
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
        task_service.initialise()
        goals.initialise()
        agent_loop.initialise()
        workflows.initialise()
        reusable_workflows.initialise()

    def tearDown(self):
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_catalog_is_static_versioned_and_contains_no_submit_recipe(self):
        items = reusable_workflows.catalog()
        ids = {item["id"] for item in items}
        self.assertEqual(
            ids,
            {
                "prepare_tomorrow",
                "deal_with_forwarded_message",
                "research_purchase",
                "plan_dinner_out",
                "prepare_client_task",
            },
        )
        self.assertTrue(all(item["version"] == 1 for item in items))
        self.assertTrue(all(item["automatic_start"] is False for item in items))
        actions = {action for item in items for action in item["actions"]}
        self.assertNotIn("browser.submit", actions)
        self.assertNotIn("email.send", actions)

    def test_prepare_tomorrow_compiles_to_existing_workflow_with_local_day_window(self):
        recipe = reusable_workflows.RECIPES["prepare_tomorrow"]
        with patch.object(
            reusable_workflows.config,
            "settings",
            replace(reusable_workflows.config.settings, timezone="Europe/London"),
        ):
            goal, steps = reusable_workflows.compile_recipe(
                recipe, {"date": "2026-07-01", "task_limit": 12}
            )
        self.assertEqual(goal, "Prepare for 2026-07-01")
        self.assertEqual(steps[0]["action"], "calendar.events.list")
        self.assertEqual(steps[0]["arguments"]["start"], "2026-07-01T00:00:00+01:00")
        self.assertEqual(steps[0]["arguments"]["end"], "2026-07-02T00:00:00+01:00")
        self.assertEqual(steps[1]["action"], "tasks.list")
        self.assertEqual(steps[1]["arguments"]["limit"], 12)

        with patch.object(
            reusable_workflows.integrations,
            "action_available",
            return_value=(True, None),
        ):
            instance = reusable_workflows.instantiate_recipe(
                "prepare_tomorrow",
                parameters={"date": "2026-07-01", "task_limit": 12},
                request_id="recipe-day-test",
            )
        self.assertEqual(instance["recipe_id"], "prepare_tomorrow")
        self.assertEqual(instance["workflow"]["goal"]["state"], "ready")
        self.assertEqual(len(instance["workflow"]["goal"]["steps"]), 2)
        self.assertEqual(reusable_workflows.status()["instances"], 1)

    def test_browser_research_recipe_uses_verified_scalar_session_binding(self):
        with patch.object(
            reusable_workflows.integrations,
            "action_available",
            return_value=(True, None),
        ):
            instance = reusable_workflows.instantiate_recipe(
                "research_purchase",
                parameters={"url": "https://example.com/product"},
                request_id="recipe-browser-test",
            )
        workflow = instance["workflow"]
        actions = [step["action"] for step in workflow["goal"]["steps"]]
        self.assertEqual(
            actions,
            ["browser.session.open", "browser.page.inspect", "browser.session.close"],
        )
        self.assertEqual(len(workflow["bindings"]), 2)
        self.assertTrue(all(item["source_step"] == 0 for item in workflow["bindings"]))
        self.assertTrue(all(item["source_path"] == "session_id" for item in workflow["bindings"]))
        self.assertNotIn("browser.submit", actions)

    def test_explicit_recipe_run_uses_agent_loop_and_stops_at_task_approval(self):
        result = asyncio.run(
            reusable_workflows.run_recipe(
                "prepare_client_task",
                parameters={
                    "title": "Review technical SEO ticket",
                    "detail": "Check acceptance criteria before implementation.",
                    "due": None,
                },
                request_id="recipe-client-task-run",
            )
        )
        self.assertEqual(result["execution_path"], "existing_bounded_agent_loop")
        self.assertFalse(result["automatic_start"])
        self.assertEqual(result["run"]["state"], "awaiting_approval")
        approval = result["run"]["steps"][-1]["approval"]
        self.assertEqual(approval["risk_level"], "safe_write")
        self.assertEqual(
            task_service.list_items(kind="task", include_completed=True, limit=20), []
        )

    def test_forwarded_message_is_not_copied_into_status_or_instance_metadata(self):
        secret = "PRIVATE FORWARDED MESSAGE CONTENT"
        instance = reusable_workflows.instantiate_recipe(
            "deal_with_forwarded_message",
            parameters={"message": secret, "due": None},
            request_id="recipe-forwarded-message",
        )
        state = reusable_workflows.status()
        self.assertNotIn(secret, json.dumps(state))
        metadata = {
            key: value
            for key, value in instance.items()
            if key != "workflow"
        }
        self.assertNotIn(secret, json.dumps(metadata))
        self.assertEqual(len(instance["parameter_hash"]), 64)
        self.assertEqual(instance["parameter_count"], 2)

    def test_invalid_parameters_and_unavailable_capability_fail_before_creation(self):
        with self.assertRaises(ValueError):
            reusable_workflows.instantiate_recipe(
                "research_purchase",
                parameters={"url": "https://user:pass@example.com"},
                request_id="recipe-invalid-url",
            )
        with self.assertRaises(ValueError):
            reusable_workflows.instantiate_recipe(
                "prepare_client_task",
                parameters={"title": "Task", "unexpected": "value"},
                request_id="recipe-invalid-param",
            )
        with patch.object(
            reusable_workflows.integrations,
            "action_available",
            return_value=(False, "Capability unavailable for test"),
        ):
            with self.assertRaisesRegex(ValueError, "Capability unavailable"):
                reusable_workflows.instantiate_recipe(
                    "research_purchase",
                    parameters={"url": "https://example.com"},
                    request_id="recipe-unavailable",
                )
        self.assertEqual(reusable_workflows.status()["instances"], 0)
        self.assertEqual(goals.status()["goals"], 0)

    def test_status_and_routes_are_content_minimised_and_authenticated_collection(self):
        state = reusable_workflows.status()
        self.assertEqual(state["mode"], "reusable_workflows_v1")
        self.assertEqual(state["recipes"], 5)
        self.assertEqual(state["definition_source"], "static_application_code_v1")
        self.assertEqual(state["creates"], "existing_phase5c_workflow_and_phase5a_goal")
        self.assertEqual(state["executor"], "existing_phase5b_bounded_agent_loop")
        self.assertEqual(state["approval_policy"], "existing_exact_scope")
        self.assertEqual(state["verification_recovery"], "existing_phase5e")
        self.assertEqual(state["browser_policy"], "existing_phase5f")
        self.assertFalse(state["automatic_start"])
        self.assertFalse(state["runtime_action_invention"])
        self.assertFalse(state["code_evaluation"])
        self.assertFalse(state["parameter_values_in_status"])
        self.assertFalse(state["cloud_models"])

        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/recipes/status", paths)
        self.assertIn("/v1/core/recipes", paths)
        self.assertIn("/v1/core/recipes/{recipe_id}/instantiate", paths)
        self.assertIn("/v1/core/recipes/{recipe_id}/run", paths)
        self.assertIn("/v1/core/recipes/instances/{instance_id}", paths)


if __name__ == "__main__":
    unittest.main()

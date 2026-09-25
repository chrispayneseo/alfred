from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app import operations, phase11_acceptance, reusable_workflows


class Phase11OperationsTests(unittest.IsolatedAsyncioTestCase):
    def test_catalog_is_static_and_backed_only_by_registered_recipes(self):
        catalog = operations.catalog()
        self.assertGreaterEqual(len(catalog), 5)
        for item in catalog:
            self.assertIn(item["recipe_id"], reusable_workflows.RECIPES)
            self.assertFalse(item["automatic_start"])
            self.assertEqual(item["execution_path"], "existing_reusable_workflow_and_agent_loop")
        self.assertFalse(operations.status()["runtime_tool_definition"])

    def test_preview_compiles_without_start_or_mutation(self):
        preview = operations.preview(
            "prepare_client_task",
            {"title": "Review client redirects", "detail": "Check migration ticket", "due": None},
        )
        self.assertEqual(preview["actions"], ["tasks.create"])
        self.assertFalse(preview["will_start"])
        self.assertFalse(preview["will_mutate"])
        self.assertFalse(preview["parameter_values_returned"])
        self.assertTrue(preview["approval_boundaries_preserved"])

    def test_runtime_operation_and_recipe_names_cannot_be_invented(self):
        with self.assertRaises(ValueError):
            operations.preview("email_everyone", {"action": "email.send"})
        with self.assertRaises(ValueError):
            operations.preview("prepare_client_task", {"title": "Task", "action": "browser.submit"})

    async def test_run_delegates_to_existing_recipe_runner(self):
        fake = {"execution_path": "existing_bounded_agent_loop", "instance": {"id": "recipe-1"}, "run": {"state": "awaiting_approval"}}
        with patch.object(reusable_workflows, "run_recipe", new=AsyncMock(return_value=fake)) as runner:
            result = await operations.run(
                "prepare_home_task", {"title": "Book boiler service", "detail": "", "due": None}, "owner-1"
            )
        runner.assert_awaited_once_with(
            "prepare_client_task",
            parameters={"title": "Book boiler service", "detail": "", "due": None},
            request_id="owner-1",
        )
        self.assertEqual(result["execution_path"], "existing_bounded_agent_loop")
        self.assertTrue(result["approval_boundaries_preserved"])


class Phase11AcceptanceTests(unittest.TestCase):
    def test_acceptance_and_previous_phase_gate(self):
        with patch.object(
            phase11_acceptance.phase10_acceptance, "acceptance_status",
            return_value={"accepted": True, "mode": "phase10_proactive_intelligence_acceptance_v1"},
        ):
            accepted = phase11_acceptance.acceptance_status()
        self.assertTrue(accepted["accepted"], accepted["failed_checks"])
        self.assertEqual(accepted["check_count"], 10)
        self.assertFalse(accepted["new_executor"])
        self.assertFalse(accepted["runtime_tool_definition"])
        self.assertFalse(accepted["automatic_purchase_or_booking"])

        with patch.object(
            phase11_acceptance.phase10_acceptance, "acceptance_status",
            return_value={"accepted": False, "mode": "phase10_proactive_intelligence_acceptance_v1"},
        ):
            failed = phase11_acceptance.acceptance_status()
        self.assertFalse(failed["accepted"])
        self.assertIn("phase10_baseline_preserved", failed["failed_checks"])


if __name__ == "__main__":
    unittest.main()

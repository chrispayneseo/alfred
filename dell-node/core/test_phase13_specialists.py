from __future__ import annotations

import unittest
from dataclasses import replace
from unittest.mock import patch

from app import cloud_execution, phase13_acceptance, specialist_orchestration
from app.providers import Provider


class Phase13SpecialistTests(unittest.TestCase):
    def _provider(self, name: str, enabled: bool = True) -> Provider:
        caps = ("reasoning", "research", "coding") if name == "openai" else ("reasoning", "coding", "long_context")
        return Provider(name=name, location="cloud", enabled=enabled, capabilities=caps, sends_off_device=True, model=f"{name}-model")

    def test_web_research_is_deterministically_openai(self):
        with patch.object(specialist_orchestration, "enabled_cloud_providers", return_value=[self._provider("openai"), self._provider("claude")]):
            plan = specialist_orchestration.plan("Research the latest browser security news on the web")
        self.assertEqual(plan.task_class, "web_research")
        self.assertEqual(plan.primary_provider, "openai")
        self.assertTrue(plan.web_search)
        self.assertFalse(plan.memory_automatically_sent)
        self.assertFalse(plan.fallback_is_automatic)

    def test_coding_prefers_configured_claude_with_one_explicit_fallback(self):
        with patch.object(specialist_orchestration, "enabled_cloud_providers", return_value=[self._provider("openai"), self._provider("claude")]):
            plan = specialist_orchestration.plan("Refactor this TypeScript repository architecture")
        self.assertEqual(plan.task_class, "coding")
        self.assertEqual(plan.primary_provider, "claude")
        self.assertEqual(plan.fallback_providers, ("openai",))
        self.assertFalse(plan.fallback_is_automatic)

    def test_explicit_provider_choice_is_respected_but_not_executed(self):
        with patch.object(specialist_orchestration, "enabled_cloud_providers", return_value=[self._provider("openai"), self._provider("claude")]):
            plan = specialist_orchestration.plan("Use ChatGPT to reason about this public question")
        self.assertEqual(plan.primary_provider, "openai")
        self.assertEqual(plan.fallback_providers, ())

    def test_private_prompt_requires_existing_cloud_approval_boundary(self):
        with patch.object(specialist_orchestration, "enabled_cloud_providers", return_value=[self._provider("openai")]), patch.object(
            specialist_orchestration, "is_private", return_value=True
        ):
            plan = specialist_orchestration.plan("Analyse this private detail")
        self.assertEqual(plan.privacy_class, "private_requires_approval")
        self.assertTrue(plan.approval_required_before_cloud)
        self.assertFalse(plan.memory_automatically_sent)

    def test_cloud_execution_uses_broker_provider_choice(self):
        with patch.object(specialist_orchestration, "enabled_cloud_providers", return_value=[self._provider("claude")]):
            self.assertEqual(cloud_execution.choose_provider("Refactor this Python code"), "claude")


class Phase13AcceptanceTests(unittest.TestCase):
    def test_contract_and_previous_phase_gate(self):
        with patch.object(
            phase13_acceptance.phase12_acceptance, "acceptance_status",
            return_value={"accepted": True, "mode": "phase12_autonomous_projects_acceptance_v1"},
        ):
            accepted = phase13_acceptance.acceptance_status()
        self.assertTrue(accepted["accepted"], accepted["failed_checks"])
        self.assertEqual(accepted["check_count"], 10)
        self.assertFalse(accepted["provider_calls"])
        self.assertFalse(accepted["automatic_fallback"])

        with patch.object(
            phase13_acceptance.phase12_acceptance, "acceptance_status",
            return_value={"accepted": False, "mode": "phase12_autonomous_projects_acceptance_v1"},
        ):
            failed = phase13_acceptance.acceptance_status()
        self.assertFalse(failed["accepted"])
        self.assertIn("phase12_baseline_preserved", failed["failed_checks"])


if __name__ == "__main__":
    unittest.main()

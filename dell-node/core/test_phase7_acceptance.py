from __future__ import annotations

import unittest
from unittest.mock import patch

from app import phase7_acceptance


GOOD_STATE = {
    "mode": "personal_agent_experience_v1",
    "phase6_accepted": True,
    "surfaces": ["phone_web", "mac_web"],
    "command_mode": "authoritative_core_command_v1",
    "inbox_mode": "agent_inbox_v1",
    "search_mode": "personal_search_local_first_v1",
    "notification_mode": "event_driven_attention_v1",
    "authoritative_core": True,
    "connected_reads_via_existing_core": True,
    "owner_reviewed_capture_reused": True,
    "exact_scope_approval_reused": True,
    "new_executor": False,
    "new_policy_path": False,
    "automatic_external_mutation": False,
    "browser_submit_enabled_by_phase7": False,
    "email_send_enabled_by_phase7": False,
    "local_search_cloud_models": False,
    "daily_briefing": False,
}


class Phase7AcceptanceTests(unittest.TestCase):
    def test_acceptance_requires_phase6_and_preserves_boundaries(self):
        with patch.object(
            phase7_acceptance.phase6_acceptance,
            "acceptance_status",
            return_value={"accepted": True, "mode": "phase6_daily_utility_acceptance_v1"},
        ), patch.object(phase7_acceptance.experience, "status", return_value=GOOD_STATE):
            result = phase7_acceptance.acceptance_status()

        self.assertTrue(result["accepted"])
        self.assertEqual(result["check_count"], 11)
        self.assertEqual(result["failed_checks"], [])
        self.assertFalse(result["executor_hooks_added"])
        self.assertFalse(result["policy_changes"])
        self.assertFalse(result["automatic_external_mutations"])

    def test_acceptance_fails_closed_without_phase6(self):
        state = dict(GOOD_STATE)
        state["phase6_accepted"] = False
        with patch.object(
            phase7_acceptance.phase6_acceptance,
            "acceptance_status",
            return_value={"accepted": False, "mode": "phase6_daily_utility_acceptance_v1"},
        ), patch.object(phase7_acceptance.experience, "status", return_value=state):
            result = phase7_acceptance.acceptance_status()

        self.assertFalse(result["accepted"])
        self.assertIn("phase6_baseline_preserved", result["failed_checks"])


if __name__ == "__main__":
    unittest.main()

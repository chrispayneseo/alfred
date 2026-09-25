import unittest
from unittest.mock import patch

from app import daily_operations, phase6_acceptance


class Phase6AcceptanceTests(unittest.TestCase):
    def test_acceptance_requires_phase5_and_preserves_boundaries(self):
        phase5 = {"mode": "phase5_hardening_acceptance_v1", "accepted": True}
        daily = {
            "mode": "daily_command_centre_v1",
            "capture_mode": "reviewed_capture_v1",
            "dispatch_mode": "phase5_guarded_dispatch_v1",
            "phase5_accepted": True,
            "sources": ["whatsapp_forward", "manual_local"],
            "local_classifier": True,
            "raw_forwarded_text_as_instruction": False,
            "owner_review_before_dispatch": True,
            "exact_scope_core_approval": True,
            "new_executor": False,
            "new_policy_path": False,
            "automatic_external_mutation": False,
            "browser_submit_enabled_by_phase6": False,
            "email_send_enabled_by_phase6": False,
            "content_policy": "owner_reviewed_titles_only",
            "cloud_models": False,
        }
        with (
            patch.object(phase6_acceptance.hardening_acceptance, "acceptance_status", return_value=phase5),
            patch.object(daily_operations, "status", return_value=daily),
        ):
            result = phase6_acceptance.acceptance_status()
        self.assertTrue(result["accepted"])
        self.assertEqual(result["check_count"], 10)
        self.assertEqual(result["failed_checks"], [])
        self.assertFalse(result["executor_hooks_added"])
        self.assertFalse(result["policy_changes"])
        self.assertFalse(result["mutations"])
        self.assertFalse(result["cloud_models"])

    def test_acceptance_fails_closed_if_phase5_is_not_accepted(self):
        phase5 = {"mode": "phase5_hardening_acceptance_v1", "accepted": False}
        with (
            patch.object(phase6_acceptance.hardening_acceptance, "acceptance_status", return_value=phase5),
            patch.object(
                daily_operations,
                "status",
                return_value={
                    "mode": "daily_command_centre_v1",
                    "capture_mode": "reviewed_capture_v1",
                    "dispatch_mode": "phase5_guarded_dispatch_v1",
                    "phase5_accepted": False,
                    "raw_forwarded_text_as_instruction": False,
                    "owner_review_before_dispatch": True,
                    "exact_scope_core_approval": True,
                    "new_executor": False,
                    "new_policy_path": False,
                    "automatic_external_mutation": False,
                    "browser_submit_enabled_by_phase6": False,
                    "email_send_enabled_by_phase6": False,
                    "content_policy": "owner_reviewed_titles_only",
                    "cloud_models": False,
                },
            ),
        ):
            result = phase6_acceptance.acceptance_status()
        self.assertFalse(result["accepted"])
        self.assertIn("phase5_baseline_preserved", result["failed_checks"])


if __name__ == "__main__":
    unittest.main()

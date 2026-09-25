from __future__ import annotations

import unittest
from unittest.mock import patch

from app import phase8_acceptance


class Phase8AcceptanceTests(unittest.TestCase):
    def test_phase8_contract_is_accepted_on_phase7_baseline(self):
        with patch.object(
            phase8_acceptance.phase7_acceptance,
            "acceptance_status",
            return_value={"accepted": True, "mode": "phase7_personal_agent_acceptance_v1"},
        ):
            payload = phase8_acceptance.acceptance_status()
        self.assertEqual(payload["mode"], "phase8_secure_authenticated_web_acceptance_v1")
        self.assertTrue(payload["accepted"], payload["failed_checks"])
        self.assertEqual(payload["check_count"], 10)
        self.assertEqual(payload["failed_checks"], [])
        self.assertFalse(payload["new_executor"])
        self.assertFalse(payload["secrets_entered_by_alfred"])
        self.assertFalse(payload["payment_data_supported"])
        self.assertFalse(payload["captcha_supported"])

    def test_phase8_fails_closed_without_phase7(self):
        with patch.object(
            phase8_acceptance.phase7_acceptance,
            "acceptance_status",
            return_value={"accepted": False, "mode": "phase7_personal_agent_acceptance_v1"},
        ):
            payload = phase8_acceptance.acceptance_status()
        self.assertFalse(payload["accepted"])
        self.assertIn("phase7_baseline_preserved", payload["failed_checks"])


if __name__ == "__main__":
    unittest.main()

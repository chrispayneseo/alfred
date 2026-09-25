import json
import unittest
from datetime import datetime
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

from app import proactive, proactive_relevance


class ProactiveRelevanceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 25, 10, 0, tzinfo=ZoneInfo("Europe/London"))

    def test_gmail_metadata_reduces_to_generic_categories_only(self):
        messages = [
            {
                "id": "private-message-1",
                "from": "Private Person <private@example.com>",
                "subject": "ACTION REQUIRED: Secret project approval",
                "snippet": "Please respond about confidential details.",
            },
            {
                "id": "private-message-2",
                "from": "Bank Person <bank@example.com>",
                "subject": "Payment failed for private account",
                "snippet": "Update the private card ending 1234.",
            },
            {
                "id": "private-message-3",
                "from": "Unknown <unknown@example.com>",
                "subject": "Private newsletter",
                "snippet": "Nothing requiring action.",
            },
        ]

        result = proactive_relevance.gmail_relevance(messages)
        encoded = json.dumps(result)

        self.assertEqual(result["mode"], "deterministic_metadata_v2")
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["classified"], 2)
        self.assertEqual(result["other"], 1)
        self.assertEqual(
            {item["key"] for item in result["categories"]},
            {"action", "finance"},
        )
        for private_value in (
            "Secret project", "confidential", "Private Person", "private@example.com",
            "private account", "ending 1234", "Private newsletter",
        ):
            self.assertNotIn(private_value, encoded)

    def test_v2_classifies_common_real_world_wording(self):
        cases = [
            ({"subject": "New login detected", "snippet": "Check this login attempt"}, "security"),
            ({"subject": "Please review and sign", "snippet": "Document awaiting signature"}, "action"),
            ({"subject": "Your payment was received", "snippet": "Receipt available"}, "finance"),
            ({"subject": "Your booking details", "snippet": "Travel information enclosed"}, "booking"),
            ({"subject": "Your order is on its way", "snippet": "Track your parcel"}, "delivery"),
        ]
        for message, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(proactive_relevance.gmail_category(message), expected)

    def test_sender_hint_alone_does_not_classify(self):
        message = {
            "from": "Security Team <security@example.com>",
            "subject": "Monthly newsletter",
            "snippet": "General news only",
        }
        self.assertIsNone(proactive_relevance.gmail_category(message))

    def test_gmail_classification_alone_never_reaches_urgent_band(self):
        messages = [
            {"subject": "Security alert: unusual sign-in", "snippet": "verify your identity"},
            {"subject": "URGENT ACTION REQUIRED", "snippet": "please respond"},
        ]
        result = proactive_relevance.gmail_relevance(messages)
        self.assertTrue(result["categories"])
        self.assertLess(max(item["priority"] for item in result["categories"]), 90)

    def test_time_sensitive_task_and_calendar_scoring(self):
        self.assertEqual(proactive_relevance.task_priority(kind="reminder", days_until_due=0), 90)
        self.assertEqual(proactive_relevance.task_priority(kind="task", days_until_due=0), 84)
        self.assertEqual(proactive_relevance.task_priority(kind="task", days_until_due=-8), 98)
        self.assertEqual(
            proactive_relevance.calendar_priority(
                hours_until_start=0.25, all_day=False, same_local_day=True
            ),
            96,
        )
        self.assertEqual(
            proactive_relevance.calendar_priority(
                hours_until_start=9, all_day=False, same_local_day=True
            ),
            74,
        )
        self.assertEqual(
            proactive_relevance.calendar_priority(
                hours_until_start=14, all_day=True, same_local_day=True
            ),
            70,
        )

    async def test_gmail_signals_store_only_generic_relevance(self):
        payload = {
            "messages": [
                {
                    "id": "m1",
                    "from": "Secret Sender <secret@example.com>",
                    "subject": "Security alert: unusual sign-in",
                    "snippet": "Private device information here",
                },
                {
                    "id": "m2",
                    "from": "Secret Sender <secret@example.com>",
                    "subject": "Ordinary private newsletter",
                    "snippet": "Private newsletter contents",
                },
            ],
            "count": 2,
        }
        with patch.object(proactive.gmail, "configured", return_value=True), \
             patch.object(proactive.gmail, "search_messages", new=AsyncMock(return_value=payload)):
            signals, state = await proactive._gmail_signals(self.now)

        self.assertEqual(state["relevance_mode"], "deterministic_metadata_v2")
        self.assertEqual(state["classified"], 1)
        self.assertEqual(state["other"], 1)
        self.assertEqual(state["categories"], {"security": 1})
        encoded = json.dumps(signals)
        self.assertIn("Account or security email", encoded)
        self.assertNotIn("Secret Sender", encoded)
        self.assertNotIn("secret@example.com", encoded)
        self.assertNotIn("unusual sign-in", encoded)
        self.assertNotIn("Private device", encoded)
        self.assertTrue(all(item["source_ref"] is None for item in signals))

    def test_status_declares_local_content_minimised_relevance(self):
        status = proactive_relevance.relevance_status()
        self.assertEqual(status["mode"], "deterministic_local")
        self.assertEqual(status["gmail"], "deterministic_metadata_v2")
        self.assertFalse(status["stores_raw_gmail_metadata"])
        self.assertFalse(status["cloud_models"])


if __name__ == "__main__":
    unittest.main()

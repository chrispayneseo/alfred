import unittest

from app import proactive_reasoning


class ProactiveReasoningTests(unittest.TestCase):
    def test_related_task_and_calendar_receive_bounded_boosts(self):
        items = [
            {
                "id": "task-1",
                "source": "tasks",
                "kind": "due_soon",
                "priority": 60,
                "title": "Prepare dentist paperwork",
                "summary": "Due tomorrow.",
            },
            {
                "id": "calendar-1",
                "source": "calendar",
                "kind": "calendar_upcoming",
                "priority": 66,
                "title": "Dentist appointment",
                "summary": "Starts Fri 09:00.",
            },
        ]

        result = proactive_reasoning.apply_cross_source_reasoning(items)
        by_id = {item["id"]: item for item in result["items"]}

        self.assertEqual(result["mode"], "deterministic_cross_source_v1")
        self.assertEqual(result["cluster_count"], 1)
        self.assertEqual(result["boosted_items"], 2)
        self.assertEqual(by_id["task-1"]["base_priority"], 60)
        self.assertEqual(by_id["task-1"]["priority"], 68)
        self.assertEqual(by_id["calendar-1"]["priority"], 74)
        self.assertEqual(by_id["task-1"]["correlated_sources"], ["calendar"])
        self.assertFalse(result["creates_urgent"])
        self.assertFalse(result["cloud_models"])

    def test_booking_email_adds_context_to_near_term_calendar(self):
        items = [
            {
                "id": "gmail-1",
                "source": "gmail",
                "kind": "gmail_booking",
                "priority": 72,
                "title": "Booking or travel email",
                "summary": "1 unread message looks related to a booking, appointment or journey.",
            },
            {
                "id": "calendar-1",
                "source": "calendar",
                "kind": "calendar_upcoming",
                "priority": 74,
                "title": "Family trip",
                "summary": "Starts at 18:00.",
            },
        ]

        result = proactive_reasoning.apply_cross_source_reasoning(items)
        by_id = {item["id"]: item for item in result["items"]}

        self.assertEqual(by_id["gmail-1"]["priority"], 75)
        self.assertEqual(by_id["calendar-1"]["priority"], 79)
        self.assertIn("gmail", by_id["calendar-1"]["correlated_sources"])
        self.assertIn("calendar", by_id["gmail-1"]["correlated_sources"])

    def test_cross_source_boost_cannot_create_urgent_item(self):
        items = [
            {
                "id": "task-1",
                "source": "tasks",
                "kind": "due_today",
                "priority": 84,
                "title": "Pay renewal invoice",
                "summary": "Due today.",
            },
            {
                "id": "calendar-1",
                "source": "calendar",
                "kind": "calendar_upcoming",
                "priority": 82,
                "title": "Renewal invoice review",
                "summary": "Starts at 14:00.",
            },
            {
                "id": "gmail-1",
                "source": "gmail",
                "kind": "gmail_finance",
                "priority": 76,
                "title": "Money or payment email",
                "summary": "1 unread message looks related to a payment or money matter.",
            },
        ]

        result = proactive_reasoning.apply_cross_source_reasoning(items)
        by_id = {item["id"]: item for item in result["items"]}

        self.assertEqual(by_id["task-1"]["base_priority"], 84)
        self.assertEqual(by_id["task-1"]["priority"], 89)
        self.assertLess(by_id["calendar-1"]["priority"], 90)
        self.assertLess(by_id["gmail-1"]["priority"], 90)
        self.assertTrue(all(item["priority"] < 90 for item in result["items"]))

    def test_existing_urgent_item_stays_urgent(self):
        items = [
            {
                "id": "task-1",
                "source": "tasks",
                "kind": "overdue",
                "priority": 94,
                "title": "Security account review",
                "summary": "Overdue.",
            },
            {
                "id": "gmail-1",
                "source": "gmail",
                "kind": "gmail_security",
                "priority": 85,
                "title": "Account or security email",
                "summary": "1 unread message looks related to account access or security.",
            },
        ]

        result = proactive_reasoning.apply_cross_source_reasoning(items)
        by_id = {item["id"]: item for item in result["items"]}

        self.assertGreaterEqual(by_id["task-1"]["priority"], 94)
        self.assertLess(by_id["gmail-1"]["priority"], 90)

    def test_same_source_items_do_not_create_cross_source_reasoning(self):
        items = [
            {"id": "t1", "source": "tasks", "kind": "due_today", "priority": 84, "title": "Dentist forms"},
            {"id": "t2", "source": "tasks", "kind": "due_soon", "priority": 72, "title": "Dentist notes"},
        ]

        result = proactive_reasoning.apply_cross_source_reasoning(items)

        self.assertEqual(result["cluster_count"], 0)
        self.assertEqual(result["boosted_items"], 0)
        self.assertEqual([item["priority"] for item in result["items"]], [84, 72])

    def test_status_declares_existing_item_only_local_reasoning(self):
        status = proactive_reasoning.reasoning_status()
        self.assertEqual(status["mode"], "deterministic_cross_source_v1")
        self.assertTrue(status["cross_source"])
        self.assertFalse(status["creates_urgent"])
        self.assertFalse(status["cloud_models"])
        self.assertEqual(status["mutation_targets"], "existing_items_only")


if __name__ == "__main__":
    unittest.main()

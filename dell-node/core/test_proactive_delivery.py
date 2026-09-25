import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from app import db, proactive_delivery


class ProactiveDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.delivery_patch = patch.object(
            proactive_delivery,
            "settings",
            replace(
                proactive_delivery.settings,
                proactive_push_enabled=True,
                proactive_morning_brief_push_enabled=True,
                web_origin="https://alfred.example",
            ),
        )
        self.db_patch.start()
        self.delivery_patch.start()
        db.initialise()
        proactive_delivery.initialise()
        self.now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
        self.topic = "a" * 40
        self.candidate = {
            "decision": "surface_candidate",
            "item": {
                "id": "item-1",
                "source": "gmail",
                "kind": "unread_email",
                "priority": 70,
                "title": "private title",
                "summary": "private summary",
            },
            "delivery": "disabled",
        }
        self.brief = {
            "brief_date": "2026-09-25",
            "counts": {"total": 1, "urgent": 0, "important": 1, "later": 0},
            "items": [{"id": "item-1", "title": "private title", "summary": "private summary"}],
        }

    def tearDown(self):
        self.delivery_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    async def test_disabled_never_calls_network(self):
        with patch.object(
            proactive_delivery,
            "settings",
            replace(proactive_delivery.settings, proactive_push_enabled=False),
        ), patch.object(proactive_delivery, "_send_ntfy", new=AsyncMock()) as send:
            result = await proactive_delivery.maybe_deliver(now=self.now)
        self.assertEqual(result["state"], "disabled")
        send.assert_not_awaited()

    async def test_policy_hold_never_calls_network(self):
        with patch.object(proactive_delivery.inbox_api, "notification_topic", return_value=self.topic), \
             patch.object(proactive_delivery.proactive_brief, "interruption_decision", return_value={
                 "decision": "hold_quiet_hours", "item": None, "delivery": "disabled"
             }), \
             patch.object(proactive_delivery, "_send_ntfy", new=AsyncMock()) as send:
            result = await proactive_delivery.maybe_deliver(now=self.now)
        self.assertEqual(result["state"], "hold_quiet_hours")
        send.assert_not_awaited()

    async def test_successful_item_is_delivered_only_once(self):
        send = AsyncMock()
        with patch.object(proactive_delivery.inbox_api, "notification_topic", return_value=self.topic), \
             patch.object(proactive_delivery.proactive_brief, "interruption_decision", return_value=self.candidate), \
             patch.object(proactive_delivery.proactive_brief, "mark_surfaced", return_value=True) as surfaced, \
             patch.object(proactive_delivery, "_send_ntfy", new=send):
            first = await proactive_delivery.maybe_deliver(now=self.now)
            second = await proactive_delivery.maybe_deliver(now=self.now + timedelta(hours=4))

        self.assertEqual(first["state"], "delivered")
        self.assertEqual(second["state"], "already_delivered")
        send.assert_awaited_once_with(self.topic, proactive_delivery.GENERIC_MESSAGE)
        surfaced.assert_called_once()
        with db.connection() as conn:
            row = conn.execute("SELECT state, error_type FROM proactive_deliveries").fetchone()
        self.assertEqual(row["state"], "delivered")
        self.assertIsNone(row["error_type"])

    async def test_failure_uses_retry_backoff(self):
        error = httpx.ConnectError(
            "offline",
            request=httpx.Request("POST", "https://ntfy.sh/example"),
        )
        send = AsyncMock(side_effect=error)
        with patch.object(proactive_delivery.inbox_api, "notification_topic", return_value=self.topic), \
             patch.object(proactive_delivery.proactive_brief, "interruption_decision", return_value=self.candidate), \
             patch.object(proactive_delivery, "_send_ntfy", new=send):
            first = await proactive_delivery.maybe_deliver(now=self.now)
            second = await proactive_delivery.maybe_deliver(now=self.now + timedelta(minutes=10))

        self.assertEqual(first["state"], "failed")
        self.assertEqual(second["state"], "retry_backoff")
        self.assertEqual(send.await_count, 1)

    async def test_morning_brief_is_generic_once_per_day_and_starts_cooldown(self):
        send = AsyncMock()
        with patch.object(proactive_delivery.inbox_api, "notification_topic", return_value=self.topic), \
             patch.object(proactive_delivery.proactive, "quiet_hours_active", return_value=False), \
             patch.object(proactive_delivery.proactive_brief, "mark_surfaced", return_value=True) as surfaced, \
             patch.object(proactive_delivery, "_send_ntfy", new=send):
            first = await proactive_delivery.maybe_deliver_morning_brief(self.brief, now=self.now)
            second = await proactive_delivery.maybe_deliver_morning_brief(
                self.brief, now=self.now + timedelta(hours=4)
            )

        self.assertEqual(first["state"], "delivered")
        self.assertEqual(second["state"], "already_delivered")
        send.assert_awaited_once_with(self.topic, proactive_delivery.MORNING_BRIEF_MESSAGE)
        surfaced.assert_called_once_with("item-1", now=self.now)

    async def test_morning_brief_respects_quiet_hours(self):
        with patch.object(proactive_delivery.proactive, "quiet_hours_active", return_value=True), \
             patch.object(proactive_delivery, "_send_ntfy", new=AsyncMock()) as send:
            result = await proactive_delivery.maybe_deliver_morning_brief(self.brief, now=self.now)
        self.assertEqual(result["state"], "hold_quiet_hours")
        send.assert_not_awaited()

    async def test_owner_triggered_test_uses_fixed_message_only(self):
        send = AsyncMock()
        with patch.object(proactive_delivery.inbox_api, "notification_topic", return_value=self.topic), \
             patch.object(proactive_delivery, "_send_ntfy", new=send):
            result = await proactive_delivery.send_test_nudge()
        self.assertEqual(result["state"], "delivered")
        self.assertEqual(result["content_policy"], "fixed_test_only")
        send.assert_awaited_once_with(self.topic, proactive_delivery.TEST_MESSAGE)

    def test_status_is_content_minimised_and_hides_topic(self):
        with patch.object(proactive_delivery.inbox_api, "notification_topic", return_value=self.topic):
            status = proactive_delivery.delivery_status()
        self.assertTrue(status["enabled"])
        self.assertTrue(status["morning_brief_enabled"])
        self.assertTrue(status["configured"])
        self.assertEqual(status["content_policy"], "generic_only")
        self.assertNotIn("topic", status)
        self.assertNotIn("title", status)
        self.assertNotIn("summary", status)

    def test_delivery_routes_use_authenticated_proactive_router(self):
        paths = {route.path for route in proactive_delivery.proactive.router.routes}
        self.assertIn("/v1/core/proactive/delivery/status", paths)
        self.assertIn("/v1/core/proactive/delivery/test", paths)


if __name__ == "__main__":
    unittest.main()

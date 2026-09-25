import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

from app import db, proactive, task_service


class ProactiveTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.db_patch.start()
        self.settings_patch = patch.object(
            proactive,
            "settings",
            replace(
                proactive.settings,
                timezone="Europe/London",
                proactive_enabled=False,
                proactive_task_horizon_days=2,
                proactive_calendar_hours=24,
                proactive_quiet_start="22:00",
                proactive_quiet_end="07:00",
                proactive_min_priority=60,
                proactive_gmail_query="is:unread newer_than:2d",
            ),
        )
        self.settings_patch.start()
        db.initialise()
        task_service.initialise()
        proactive.initialise()
        self.now = datetime(2026, 9, 25, 10, 0, tzinfo=ZoneInfo("Europe/London"))

    def tearDown(self):
        self.settings_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    async def test_due_task_is_deduplicated_across_refreshes(self):
        task_service.create(kind="reminder", title="Renew certificate", due="2026-09-25")
        with patch.object(proactive.google_calendar, "configured", return_value=False), \
             patch.object(proactive.gmail, "configured", return_value=False):
            first = await proactive.refresh(now=self.now)
            second = await proactive.refresh(now=self.now)

        self.assertEqual(first["signal_count"], 1)
        self.assertEqual(second["signal_count"], 1)
        feed = proactive.feed(now=self.now)
        self.assertEqual(feed["count"], 1)
        self.assertEqual(feed["items"][0]["source"], "tasks")
        self.assertEqual(feed["items"][0]["kind"], "due_today")
        self.assertEqual(feed["items"][0]["priority"], 90)

    async def test_dismissal_survives_matching_refresh(self):
        task_service.create(kind="task", title="Submit report", due="2026-09-25")
        with patch.object(proactive.google_calendar, "configured", return_value=False), \
             patch.object(proactive.gmail, "configured", return_value=False):
            await proactive.refresh(now=self.now)
            item_id = proactive.feed(now=self.now)["items"][0]["id"]
            self.assertTrue(proactive.dismiss(item_id))
            await proactive.refresh(now=self.now)

        self.assertEqual(proactive.feed(now=self.now)["count"], 0)

    async def test_calendar_and_gmail_create_local_signals_without_mail_content(self):
        event_start = (self.now + timedelta(hours=1)).isoformat()
        calendar_payload = {
            "events": [{
                "id": "event-1",
                "summary": "Dentist",
                "start": event_start,
                "end": (self.now + timedelta(hours=2)).isoformat(),
                "all_day": False,
                "status": "confirmed",
            }]
        }
        gmail_payload = {
            "messages": [
                {"id": "m1", "subject": "Private subject one"},
                {"id": "m2", "subject": "Private subject two"},
            ],
            "count": 2,
        }
        with patch.object(proactive.google_calendar, "configured", return_value=True), \
             patch.object(proactive.google_calendar, "list_events", new=AsyncMock(return_value=calendar_payload)), \
             patch.object(proactive.gmail, "configured", return_value=True), \
             patch.object(proactive.gmail, "search_messages", new=AsyncMock(return_value=gmail_payload)):
            result = await proactive.refresh(now=self.now)

        self.assertEqual(result["state"], "completed")
        feed = proactive.feed(now=self.now)
        self.assertEqual({item["source"] for item in feed["items"]}, {"calendar", "gmail"})
        gmail_item = next(item for item in feed["items"] if item["source"] == "gmail")
        self.assertEqual(gmail_item["title"], "Unread emails")
        self.assertNotIn("Private subject", gmail_item["summary"])

    async def test_unavailable_source_does_not_erase_previous_observation(self):
        calendar_payload = {
            "events": [{
                "id": "event-1",
                "summary": "School pickup",
                "start": (self.now + timedelta(hours=3)).isoformat(),
                "end": (self.now + timedelta(hours=4)).isoformat(),
                "all_day": False,
                "status": "confirmed",
            }]
        }
        with patch.object(proactive.google_calendar, "configured", return_value=True), \
             patch.object(proactive.google_calendar, "list_events", new=AsyncMock(return_value=calendar_payload)), \
             patch.object(proactive.gmail, "configured", return_value=False):
            await proactive.refresh(now=self.now)

        with patch.object(proactive.google_calendar, "configured", return_value=True), \
             patch.object(proactive.google_calendar, "list_events", new=AsyncMock(side_effect=RuntimeError("offline"))), \
             patch.object(proactive.gmail, "configured", return_value=False):
            result = await proactive.refresh(now=self.now)

        self.assertEqual(result["state"], "degraded")
        self.assertEqual(result["sources"]["calendar"]["error_type"], "RuntimeError")
        self.assertEqual(proactive.feed(now=self.now)["count"], 1)

    def test_quiet_hours_cross_midnight(self):
        self.assertTrue(proactive.quiet_hours_active(
            datetime(2026, 9, 25, 23, 0, tzinfo=ZoneInfo("Europe/London"))))
        self.assertTrue(proactive.quiet_hours_active(
            datetime(2026, 9, 26, 6, 30, tzinfo=ZoneInfo("Europe/London"))))
        self.assertFalse(proactive.quiet_hours_active(
            datetime(2026, 9, 25, 12, 0, tzinfo=ZoneInfo("Europe/London"))))


if __name__ == "__main__":
    unittest.main()

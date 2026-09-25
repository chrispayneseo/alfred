import tempfile
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app import db, proactive, proactive_brief, proactive_schedule, task_service


class ProactiveScheduleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.db_patch.start()
        self.proactive_patch = patch.object(
            proactive,
            "settings",
            replace(
                proactive.settings,
                timezone="Europe/London",
                proactive_enabled=False,
                proactive_task_horizon_days=2,
                proactive_quiet_start="22:00",
                proactive_quiet_end="07:00",
                proactive_min_priority=60,
            ),
        )
        self.brief_patch = patch.object(
            proactive_brief,
            "settings",
            replace(
                proactive_brief.settings,
                proactive_min_priority=60,
                proactive_cooldown_minutes=180,
            ),
        )
        self.schedule_patch = patch.object(
            proactive_schedule,
            "settings",
            replace(
                proactive_schedule.settings,
                proactive_enabled=False,
                proactive_poll_seconds=900,
                proactive_morning_brief_enabled=True,
                proactive_morning_brief_time="08:00",
                proactive_morning_brief_max_items=8,
                proactive_brief_retention_days=14,
            ),
        )
        self.proactive_patch.start()
        self.brief_patch.start()
        self.schedule_patch.start()
        db.initialise()
        task_service.initialise()
        proactive.initialise()
        proactive_schedule.initialise()
        self.zone = ZoneInfo("Europe/London")

    def tearDown(self):
        self.schedule_patch.stop()
        self.brief_patch.stop()
        self.proactive_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    async def _refresh_tasks_only(self, now):
        with patch.object(proactive.google_calendar, "configured", return_value=False), \
             patch.object(proactive.gmail, "configured", return_value=False):
            return await proactive.refresh(now=now)

    async def test_brief_waits_until_schedule_then_catches_up(self):
        task_service.create(kind="reminder", title="Morning task", due="2026-09-25")
        early = datetime(2026, 9, 25, 7, 30, tzinfo=self.zone)
        later = datetime(2026, 9, 25, 10, 0, tzinfo=self.zone)
        await self._refresh_tasks_only(early)

        before = await proactive_schedule.maybe_generate(now=early)
        after = await proactive_schedule.maybe_generate(now=later)

        self.assertFalse(before["generated"])
        self.assertEqual(before["reason"], "before_schedule")
        self.assertTrue(after["generated"])
        self.assertEqual(after["brief"]["brief_date"], "2026-09-25")
        self.assertEqual(after["brief"]["delivery"], "disabled")
        self.assertEqual(after["brief"]["synthesis"], "deterministic_local")

    async def test_only_one_snapshot_is_created_per_local_day(self):
        task_service.create(kind="task", title="Daily item", due="2026-09-25")
        now = datetime(2026, 9, 25, 10, 0, tzinfo=self.zone)
        await self._refresh_tasks_only(now)

        first = await proactive_schedule.maybe_generate(now=now, source_run_id="run-1")
        second = await proactive_schedule.maybe_generate(now=now, source_run_id="run-2")

        self.assertTrue(first["generated"])
        self.assertFalse(second["generated"])
        self.assertEqual(second["reason"], "already_generated")
        self.assertEqual(first["brief"]["id"], second["brief"]["id"])
        with db.connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM proactive_briefs").fetchone()[0]
        self.assertEqual(count, 1)

    async def test_manual_generation_refreshes_then_stores_snapshot(self):
        task_service.create(kind="reminder", title="Manual brief item", due="2026-09-25")
        now = datetime(2026, 9, 25, 6, 0, tzinfo=self.zone)
        with patch.object(proactive.google_calendar, "configured", return_value=False), \
             patch.object(proactive.gmail, "configured", return_value=False):
            result = await proactive_schedule.generate_now(now=now)

        self.assertTrue(result["generated"])
        self.assertEqual(result["brief"]["brief_date"], "2026-09-25")
        self.assertEqual(result["brief"]["counts"]["urgent"], 1)

    def test_due_status_is_content_minimised(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=self.zone)
        status = proactive_schedule.due_status(now=now)
        self.assertTrue(status["due"])
        self.assertEqual(status["scheduled_time"], "08:00")
        self.assertEqual(status["delivery"], "disabled")
        self.assertNotIn("items", status)
        self.assertNotIn("headline", status)

    def test_routes_registered_on_existing_proactive_router(self):
        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/proactive/morning-brief/status", paths)
        self.assertIn("/v1/core/proactive/morning-brief/latest", paths)
        self.assertIn("/v1/core/proactive/morning-brief/generate", paths)


if __name__ == "__main__":
    unittest.main()

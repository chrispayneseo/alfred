import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app import db, proactive, proactive_brief, task_service


class ProactiveBriefTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.db_patch.start()
        self.proactive_settings = patch.object(
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
                proactive_cooldown_minutes=120,
            ),
        )
        self.brief_settings = patch.object(
            proactive_brief,
            "settings",
            replace(
                proactive_brief.settings,
                proactive_min_priority=60,
                proactive_cooldown_minutes=120,
            ),
        )
        self.proactive_settings.start()
        self.brief_settings.start()
        db.initialise()
        task_service.initialise()
        proactive.initialise()
        self.now = datetime(2026, 9, 25, 10, 0, tzinfo=ZoneInfo("Europe/London"))

    def tearDown(self):
        self.brief_settings.stop()
        self.proactive_settings.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    async def _refresh_tasks_only(self):
        with patch.object(proactive.google_calendar, "configured", return_value=False), \
             patch.object(proactive.gmail, "configured", return_value=False):
            await proactive.refresh(now=self.now)

    async def test_brief_groups_urgent_before_lower_priority(self):
        task_service.create(kind="reminder", title="Renew certificate", due="2026-09-25")
        task_service.create(kind="task", title="Prepare notes", due="2026-09-26")
        await self._refresh_tasks_only()

        brief = proactive_brief.build_brief(now=self.now)

        self.assertEqual(brief["synthesis"], "deterministic_local")
        self.assertEqual(brief["delivery"], "disabled")
        self.assertEqual(brief["counts"]["urgent"], 1)
        self.assertEqual(brief["items"][0]["band"], "urgent")
        self.assertEqual(brief["items"][0]["title"], "Renew certificate")

    async def test_quiet_hours_hold_everything(self):
        task_service.create(kind="reminder", title="Urgent reminder", due="2026-09-25")
        await self._refresh_tasks_only()
        quiet = datetime(2026, 9, 25, 23, 0, tzinfo=ZoneInfo("Europe/London"))

        decision = proactive_brief.interruption_decision(now=quiet)

        self.assertEqual(decision["decision"], "hold_quiet_hours")
        self.assertIsNone(decision["item"])

    async def test_normal_item_respects_cooldown_but_urgent_can_break_it(self):
        task_service.create(kind="task", title="Tomorrow task", due="2026-09-26")
        await self._refresh_tasks_only()
        item = proactive.feed(now=self.now)["items"][0]
        self.assertTrue(proactive_brief.mark_surfaced(item["id"], now=self.now))

        normal = proactive_brief.interruption_decision(now=self.now + timedelta(minutes=20))
        self.assertEqual(normal["decision"], "hold_cooldown")

        task_service.create(kind="reminder", title="Urgent today", due="2026-09-25")
        await self._refresh_tasks_only()
        urgent = proactive_brief.interruption_decision(now=self.now + timedelta(minutes=20))
        self.assertEqual(urgent["decision"], "surface_candidate")
        self.assertGreaterEqual(urgent["item"]["priority"], 90)


if __name__ == "__main__":
    unittest.main()

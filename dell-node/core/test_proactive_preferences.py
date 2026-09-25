import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from app import db, proactive, proactive_brief, proactive_preferences, proactive_schedule


class ProactivePreferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.db_patch.start()
        db.initialise()
        proactive_preferences.initialise()

    def tearDown(self):
        self.db_patch.stop()
        self.temp.cleanup()

    def test_environment_values_are_defaults_until_overridden(self):
        defaults = replace(
            proactive_preferences.settings,
            proactive_enabled=True,
            proactive_poll_seconds=900,
            proactive_quiet_start="22:00",
            proactive_quiet_end="07:00",
            proactive_min_priority=60,
            proactive_cooldown_minutes=180,
            proactive_morning_brief_enabled=True,
            proactive_morning_brief_time="08:00",
        )
        current = proactive_preferences.current(defaults)
        self.assertTrue(current["enabled"])
        self.assertEqual(current["poll_seconds"], 900)
        self.assertEqual(current["morning_brief_time"], "08:00")
        self.assertEqual(current["source"], "environment_defaults")
        self.assertEqual(current["delivery"], "disabled")

    def test_updates_are_durable_and_partial(self):
        proactive_preferences.update(proactive_preferences.PreferencesUpdate(
            quiet_start="21:30",
            min_priority=72,
            cooldown_minutes=90,
        ))
        current = proactive_preferences.current()
        self.assertEqual(current["quiet_start"], "21:30")
        self.assertEqual(current["min_priority"], 72)
        self.assertEqual(current["cooldown_minutes"], 90)
        self.assertEqual(current["source"], "local_override")

    def test_runtime_application_updates_all_proactive_modules(self):
        proactive_preferences.update(proactive_preferences.PreferencesUpdate(
            enabled=False,
            poll_seconds=600,
            morning_brief_time="07:45",
        ))
        proactive_preferences.apply_runtime_preferences()
        self.assertFalse(proactive.settings.proactive_enabled)
        self.assertFalse(proactive_brief.settings.proactive_enabled)
        self.assertFalse(proactive_schedule.settings.proactive_enabled)
        self.assertEqual(proactive.settings.proactive_poll_seconds, 600)
        self.assertEqual(proactive_schedule.settings.proactive_morning_brief_time, "07:45")

    def test_invalid_clock_and_bounds_fail_closed(self):
        with self.assertRaises(ValidationError):
            proactive_preferences.PreferencesUpdate(quiet_start="25:00")
        with self.assertRaises(ValidationError):
            proactive_preferences.PreferencesUpdate(poll_seconds=30)
        with self.assertRaises(ValidationError):
            proactive_preferences.PreferencesUpdate(min_priority=101)

    def test_settings_routes_share_existing_proactive_router(self):
        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/proactive/settings", paths)


if __name__ == "__main__":
    unittest.main()

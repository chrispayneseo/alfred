import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import config, db, execution, google_calendar


class GoogleCalendarTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.execution_connection_patch = patch.object(execution, "connection", db.connection)
        self.db_patch.start()
        self.execution_connection_patch.start()
        db.initialise()
        execution.initialise_execution_store()

    def tearDown(self):
        self.execution_connection_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    def _configured(self):
        return replace(
            config.settings,
            google_client_id="calendar-client-id",
            google_client_secret="calendar-client-secret",
            google_refresh_token="calendar-refresh-token",
            google_calendar_id="primary",
        )

    def test_unconfigured_calendar_is_denied_without_approval_or_execution(self):
        unconfigured = replace(
            config.settings,
            google_client_id="",
            google_client_secret="",
            google_refresh_token="",
        )
        with patch.object(config, "settings", unconfigured):
            result = asyncio.run(execution.execute_tool(
                request_id="req-calendar-off",
                action="calendar.events.list",
                arguments={
                    "start": "2026-09-25T00:00:00+01:00",
                    "end": "2026-09-26T00:00:00+01:00",
                },
            ))
        self.assertEqual(result["state"], "denied")
        self.assertIn("not configured", result["error"])
        with db.connection() as connection:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM approvals WHERE request_id = ?", ("req-calendar-off",)
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE request_id = ?", ("req-calendar-off",)
            ).fetchone()[0], 0)

    def test_configured_calendar_read_is_automatic_and_verified(self):
        configured = self._configured()
        result_payload = {
            "ok": True,
            "calendar_id": "primary",
            "events": [{
                "id": "event-1",
                "summary": "Dentist",
                "start": "2026-09-25T10:00:00+01:00",
                "end": "2026-09-25T10:30:00+01:00",
                "all_day": False,
                "status": "confirmed",
            }],
            "window": {
                "start": "2026-09-24T23:00:00Z",
                "end": "2026-09-25T23:00:00Z",
            },
        }
        with (
            patch.object(config, "settings", configured),
            patch.object(execution, "google_calendar_list_events", new=AsyncMock(return_value=result_payload)),
        ):
            result = asyncio.run(execution.execute_tool(
                request_id="req-calendar-read",
                action="calendar.events.list",
                arguments={
                    "start": "2026-09-25T00:00:00+01:00",
                    "end": "2026-09-26T00:00:00+01:00",
                    "limit": 10,
                },
            ))
        self.assertEqual(result["state"], "completed")
        self.assertIsNone(result["approval"])
        self.assertEqual(result["result"]["events"][0]["summary"], "Dentist")
        self.assertEqual(result["verification"]["method"], "calendar_events")
        self.assertTrue(result["verification"]["ok"])
        self.assertEqual(result["verification"]["event_count"], 1)

    def test_calendar_window_requires_timezone_and_is_bounded(self):
        with self.assertRaisesRegex(ValueError, "timezone"):
            google_calendar.validate_window(
                "2026-09-25T10:00:00", "2026-09-25T11:00:00+01:00"
            )
        with self.assertRaisesRegex(ValueError, "after start"):
            google_calendar.validate_window(
                "2026-09-25T11:00:00+01:00", "2026-09-25T10:00:00+01:00"
            )
        with self.assertRaisesRegex(ValueError, "31 days"):
            google_calendar.validate_window(
                "2026-09-01T00:00:00+01:00", "2026-10-03T00:00:00+01:00"
            )

    def test_event_sanitisation_discards_private_and_unneeded_fields(self):
        raw = {
            "id": "event-secret-test",
            "summary": "School meeting",
            "description": "Private long description",
            "location": "Private address",
            "attendees": [{"email": "someone@example.com"}],
            "conferenceData": {"entryPoints": [{"uri": "https://meet.example"}]},
            "start": {"dateTime": "2026-09-25T15:00:00+01:00"},
            "end": {"dateTime": "2026-09-25T16:00:00+01:00"},
            "status": "confirmed",
        }
        event = google_calendar._sanitise_event(raw)
        self.assertEqual(set(event), {"id", "summary", "start", "end", "all_day", "status"})
        serialized = str(event)
        self.assertNotIn("Private long description", serialized)
        self.assertNotIn("Private address", serialized)
        self.assertNotIn("someone@example.com", serialized)
        self.assertNotIn("meet.example", serialized)

    def test_all_day_event_is_preserved_without_extra_payload(self):
        event = google_calendar._sanitise_event({
            "id": "all-day-1",
            "summary": "Holiday",
            "start": {"date": "2026-12-25"},
            "end": {"date": "2026-12-26"},
            "status": "confirmed",
        })
        self.assertTrue(event["all_day"])
        self.assertEqual(event["start"], "2026-12-25")
        self.assertEqual(event["end"], "2026-12-26")


if __name__ == "__main__":
    unittest.main()

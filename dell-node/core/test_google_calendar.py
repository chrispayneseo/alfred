import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import config, db, execution, google_calendar, integration_adapters


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

    def _configured(self, *, write_enabled=False):
        return replace(
            config.settings,
            google_client_id="calendar-client-id",
            google_client_secret="calendar-client-secret",
            google_refresh_token="calendar-refresh-token",
            google_calendar_id="primary",
            google_calendar_write_enabled=write_enabled,
        )

    def test_unconfigured_calendar_is_denied_without_approval_or_execution(self):
        unconfigured = replace(config.settings, google_client_id="", google_client_secret="", google_refresh_token="")
        with patch.object(config, "settings", unconfigured):
            result = asyncio.run(execution.execute_tool(
                request_id="req-calendar-off", action="calendar.events.list",
                arguments={"start": "2026-09-25T00:00:00+01:00", "end": "2026-09-26T00:00:00+01:00"},
            ))
        self.assertEqual(result["state"], "denied")
        self.assertIn("not configured", result["error"])

    def test_configured_calendar_read_is_automatic_and_verified(self):
        configured = self._configured()
        result_payload = {"ok": True, "calendar_id": "primary", "events": [{"id": "event-1", "summary": "Dentist", "start": "2026-09-25T10:00:00+01:00", "end": "2026-09-25T10:30:00+01:00", "all_day": False, "status": "confirmed"}], "window": {"start": "2026-09-24T23:00:00Z", "end": "2026-09-25T23:00:00Z"}}
        with patch.object(config, "settings", configured), patch.object(integration_adapters, "google_calendar_list_events", new=AsyncMock(return_value=result_payload)):
            result = asyncio.run(execution.execute_tool(request_id="req-calendar-read", action="calendar.events.list", arguments={"start": "2026-09-25T00:00:00+01:00", "end": "2026-09-26T00:00:00+01:00", "limit": 10}))
        self.assertEqual(result["state"], "completed")
        self.assertIsNone(result["approval"])
        self.assertTrue(result["verification"]["ok"])

    def test_calendar_write_gate_denies_before_approval_or_execution(self):
        configured = self._configured(write_enabled=False)
        with patch.object(config, "settings", configured):
            result = asyncio.run(execution.execute_tool(
                request_id="req-calendar-write-off", action="calendar.events.create",
                arguments={"summary": "Dentist", "start": "2026-10-01T10:00:00+01:00", "end": "2026-10-01T10:30:00+01:00"},
            ))
        self.assertEqual(result["state"], "denied")
        self.assertIn("write capability is disabled", result["error"])
        with db.connection() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM approvals WHERE request_id = ?", ("req-calendar-write-off",)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM core_executions WHERE request_id = ?", ("req-calendar-write-off",)).fetchone()[0], 0)

    def test_calendar_create_is_routine_reversible_and_verifies_event(self):
        configured = self._configured(write_enabled=True)
        arguments = {"summary": "Dentist", "start": "2026-10-01T10:00:00+01:00", "end": "2026-10-01T10:30:00+01:00"}
        payload = {"ok": True, "event": {"id": "event-2", "summary": "Dentist", "start": arguments["start"], "end": arguments["end"], "all_day": False, "status": "confirmed"}}
        with (
            patch.object(config, "settings", configured),
            patch.object(integration_adapters, "google_calendar_create_event", new=AsyncMock(return_value=payload)),
        ):
            result = asyncio.run(execution.execute_tool(request_id="req-calendar-create", action="calendar.events.create", arguments=arguments))
        self.assertEqual(result["state"], "completed")
        self.assertIsNone(result["approval"])
        self.assertTrue(result["verification"]["ok"])
        self.assertEqual(result["verification"]["method"], "calendar_event")

    def test_calendar_mutation_validation_is_bounded(self):
        with self.assertRaisesRegex(ValueError, "timezone"):
            google_calendar.validate_event_window("2026-10-01T10:00:00", "2026-10-01T11:00:00+01:00")
        with self.assertRaisesRegex(ValueError, "after start"):
            google_calendar.validate_event_window("2026-10-01T11:00:00+01:00", "2026-10-01T10:00:00+01:00")
        with self.assertRaisesRegex(ValueError, "7 days"):
            google_calendar.validate_event_window("2026-10-01T10:00:00+01:00", "2026-10-09T10:00:00+01:00")

    def test_event_sanitisation_discards_private_and_unneeded_fields(self):
        raw = {"id": "event-secret-test", "summary": "School meeting", "description": "Private long description", "location": "Private address", "attendees": [{"email": "someone@example.com"}], "conferenceData": {"entryPoints": [{"uri": "https://meet.example"}]}, "start": {"dateTime": "2026-09-25T15:00:00+01:00"}, "end": {"dateTime": "2026-09-25T16:00:00+01:00"}, "status": "confirmed"}
        event = google_calendar._sanitise_event(raw)
        self.assertEqual(set(event), {"id", "summary", "start", "end", "all_day", "status"})
        serialized = str(event)
        self.assertNotIn("Private long description", serialized)
        self.assertNotIn("Private address", serialized)
        self.assertNotIn("someone@example.com", serialized)


if __name__ == "__main__":
    unittest.main()

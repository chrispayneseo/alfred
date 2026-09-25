import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import capability_status, config, db, main


class CapabilityStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.core_path = str(base / "core.sqlite3")
        self.files_path = str(base / "files")
        Path(self.files_path).mkdir()
        self.patch_db = patch.object(db, "settings", replace(db.settings, sqlite_path=self.core_path))
        self.patch_db.start()
        db.initialise()

    def tearDown(self):
        self.patch_db.stop()
        self.temp.cleanup()

    def test_core_routes_include_capabilities_and_preserve_whatsapp_urls(self):
        paths = {route.path for route in main.app.routes}
        self.assertIn("/v1/core/capabilities", paths)
        self.assertIn("/v1/core/whatsapp/{message_id}", paths)
        self.assertIn("/v1/core/whatsapp/{message_id}/propose", paths)

    def test_snapshot_exposes_capability_policy_without_credentials_or_raw_arguments(self):
        secret_values = [
            "calendar-client-secret",
            "calendar-refresh-secret",
            "gmail-read-secret",
            "gmail-read-refresh-secret",
            "gmail-write-secret",
            "gmail-write-refresh-secret",
            "home-assistant-secret",
        ]
        settings = replace(
            config.settings,
            ha_url="http://homeassistant.local:8123",
            ha_token=secret_values[6],
            files_enabled=True,
            files_root=self.files_path,
            google_client_id="calendar-client",
            google_client_secret=secret_values[0],
            google_refresh_token=secret_values[1],
            google_calendar_id="primary",
            google_calendar_write_enabled=False,
            gmail_client_id="gmail-read-client",
            gmail_client_secret=secret_values[2],
            gmail_refresh_token=secret_values[3],
            gmail_user_id="me",
            gmail_write_client_id="gmail-write-client",
            gmail_write_client_secret=secret_values[4],
            gmail_write_refresh_token=secret_values[5],
            gmail_write_enabled=False,
        )
        health = [
            {"id": "alfred_tasks", "state": "ready"},
            {"id": "home_assistant", "state": "ready"},
            {"id": "local_files", "state": "ready"},
            {"id": "google_calendar", "state": "ready"},
            {"id": "gmail", "state": "ready"},
        ]
        with (
            patch.object(config, "settings", settings),
            patch.object(capability_status, "integration_health", new=AsyncMock(return_value=health)),
        ):
            result = asyncio.run(capability_status.snapshot())

        encoded = json.dumps(result)
        for secret in secret_values:
            self.assertNotIn(secret, encoded)
        self.assertNotIn(self.files_path, encoded)
        self.assertNotIn("arguments", encoded)
        self.assertEqual(result["phase"], 3)

        integrations = {item["id"]: item for item in result["integrations"]}
        calendar = {item["action"]: item for item in integrations["google_calendar"]["capabilities"]}
        gmail = {item["action"]: item for item in integrations["gmail"]["capabilities"]}
        self.assertTrue(calendar["calendar.events.list"]["enabled"])
        self.assertFalse(calendar["calendar.events.create"]["enabled"])
        self.assertEqual(calendar["calendar.events.create"]["permission"], "confirm")
        self.assertFalse(gmail["email.draft.create"]["enabled"])
        self.assertEqual(gmail["email.draft.create"]["risk"], "external")

    def test_pending_approval_surface_is_metadata_only(self):
        approval = db.create_approval(
            "request-capability-test",
            "plan-capability-test",
            "tasks.create",
            "Create a new task.",
            "safe_write",
            scope_hash="a" * 64,
            step_index=0,
        )
        with patch.object(capability_status, "integration_health", new=AsyncMock(return_value=[])):
            result = asyncio.run(capability_status.snapshot())

        self.assertEqual(result["approvals"]["pending_count"], 1)
        item = result["approvals"]["items"][0]
        self.assertEqual(item["id"], approval["id"])
        self.assertEqual(item["action"], "tasks.create")
        self.assertEqual(item["integration"], "alfred_tasks")
        self.assertEqual(item["risk_level"], "safe_write")
        self.assertNotIn("scope_hash", item)
        self.assertNotIn("step_index", item)
        self.assertNotIn("arguments", item)

    def test_resolved_approvals_drop_out_of_pending_status(self):
        approval = db.create_approval(
            "request-resolved",
            None,
            "memory.write",
            "Save memory.",
            "safe_write",
        )
        db.resolve_approval(approval["id"], "rejected")
        with patch.object(capability_status, "integration_health", new=AsyncMock(return_value=[])):
            result = asyncio.run(capability_status.snapshot())
        self.assertEqual(result["approvals"]["pending_count"], 0)
        self.assertEqual(result["approvals"]["items"], [])


if __name__ == "__main__":
    unittest.main()

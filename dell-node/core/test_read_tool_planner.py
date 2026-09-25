import asyncio
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

from app import config, db, inbox_api, orchestrator, read_tool_planner


class ReadToolPlannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.core_path = str(base / "core.sqlite3")
        self.patch_db = patch.object(db, "settings", replace(db.settings, sqlite_path=self.core_path))
        self.patch_inbox = patch.object(inbox_api, "INBOX_DB", str(base / "inbox.sqlite3"))
        self.patch_db.start()
        self.patch_inbox.start()
        db.initialise()
        inbox_api.initialise()

    def tearDown(self):
        self.patch_inbox.stop()
        self.patch_db.stop()
        self.temp.cleanup()

    def test_calendar_tomorrow_uses_local_timezone_window(self):
        settings = replace(config.settings, timezone="Europe/London")
        now = datetime(2026, 9, 25, 8, 30, tzinfo=ZoneInfo("Europe/London"))
        with patch.object(config, "settings", settings):
            plan = read_tool_planner.plan_read_tool("What's on my calendar tomorrow?", now=now)
        self.assertIsNotNone(plan)
        self.assertEqual(plan.action, "calendar.events.list")
        self.assertEqual(plan.integration, "google_calendar")
        self.assertEqual(plan.arguments["start"], "2026-09-26T00:00:00+01:00")
        self.assertEqual(plan.arguments["end"], "2026-09-27T00:00:00+01:00")

    def test_gmail_search_builds_bounded_query(self):
        plan = read_tool_planner.plan_read_tool(
            "Find unread emails from billing@example.com about invoice"
        )
        self.assertIsNotNone(plan)
        self.assertEqual(plan.action, "email.messages.search")
        self.assertIn("is:unread", plan.arguments["query"])
        self.assertIn("from:billing@example.com", plan.arguments["query"])
        self.assertIn("invoice", plan.arguments["query"])
        self.assertLessEqual(len(plan.arguments["query"]), 500)

    def test_tasks_and_explicit_home_assistant_reads_are_planned(self):
        tasks = read_tool_planner.plan_read_tool("Show my open tasks")
        self.assertEqual(tasks.action, "tasks.list")
        self.assertEqual(tasks.arguments["kind"], "task")

        home = read_tool_planner.plan_read_tool("What is the status of light.study?")
        self.assertEqual(home.action, "home_assistant.state")
        self.assertEqual(home.arguments["entity_id"], "light.study")

    def test_mutation_language_is_never_turned_into_read_plan(self):
        for message in (
            "Add dentist to my calendar tomorrow",
            "Send an email to alex@example.com",
            "Delete my reminder",
            "Change light.study",
        ):
            self.assertIsNone(read_tool_planner.plan_read_tool(message), message)

    def test_configured_calendar_read_routes_through_tool_without_model(self):
        configured = replace(
            config.settings,
            google_client_id="client",
            google_client_secret="secret",
            google_refresh_token="refresh",
            google_calendar_id="primary",
        )
        completed = {
            "state": "completed",
            "result": {
                "ok": True,
                "events": [{
                    "id": "event-1",
                    "summary": "Dentist",
                    "start": "2026-09-26T10:00:00+01:00",
                    "end": "2026-09-26T10:30:00+01:00",
                    "all_day": False,
                    "status": "confirmed",
                }],
                "window": {},
            },
            "verification": {"ok": True, "method": "calendar_events"},
        }
        with (
            patch.object(config, "settings", configured),
            patch.object(orchestrator, "execute_tool", new=AsyncMock(return_value=completed)) as execute,
            patch.object(orchestrator, "ollama_route", new=AsyncMock(side_effect=AssertionError("router should not run"))),
            patch.object(orchestrator, "ollama_chat", new=AsyncMock(side_effect=AssertionError("chat model should not run"))),
            patch.object(orchestrator, "execute_cloud_request", new=AsyncMock(side_effect=AssertionError("cloud should not run"))),
        ):
            result = asyncio.run(orchestrator.orchestrate(
                channel="web",
                message="What's on my calendar tomorrow?",
                conversation_id="calendar-tool-conv",
            ))
        self.assertEqual(result["decision"], "tool")
        self.assertEqual(result["integration"], "google_calendar")
        self.assertEqual(result["tool_action"], "calendar.events.list")
        self.assertIn("Dentist", result["reply"])
        self.assertEqual(len(result["sources"]), 1)
        self.assertEqual(execute.await_args.kwargs["action"], "calendar.events.list")

    def test_configured_gmail_search_routes_through_tool_without_cloud(self):
        configured = replace(
            config.settings,
            gmail_client_id="client",
            gmail_client_secret="secret",
            gmail_refresh_token="refresh",
            gmail_user_id="me",
        )
        completed = {
            "state": "completed",
            "result": {
                "ok": True,
                "messages": [{
                    "id": "abc123def",
                    "thread_id": "abc123",
                    "from": "Billing <billing@example.com>",
                    "to": "me@example.com",
                    "subject": "September invoice",
                    "date": "Fri, 25 Sep 2026 08:00:00 +0100",
                    "snippet": "Invoice attached",
                    "unread": True,
                }],
                "count": 1,
            },
            "verification": {"ok": True, "method": "email_search"},
        }
        with (
            patch.object(config, "settings", configured),
            patch.object(orchestrator, "execute_tool", new=AsyncMock(return_value=completed)),
            patch.object(orchestrator, "execute_cloud_request", new=AsyncMock(side_effect=AssertionError("cloud should not run"))),
        ):
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="Find unread emails from billing@example.com about invoice",
            ))
        self.assertEqual(result["decision"], "tool")
        self.assertEqual(result["integration"], "gmail")
        self.assertIn("September invoice", result["reply"])
        self.assertFalse(result["memory_sent"])

    def test_unconfigured_planned_read_returns_connection_needed(self):
        unconfigured = replace(
            config.settings,
            gmail_client_id="",
            gmail_client_secret="",
            gmail_refresh_token="",
        )
        with patch.object(config, "settings", unconfigured):
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="Show my unread emails",
            ))
        self.assertEqual(result["decision"], "connection_needed")
        self.assertEqual(result["integration"], "gmail")
        self.assertEqual(result["tool_action"], "email.messages.search")
        self.assertIn("not configured", result["reason"].casefold())


if __name__ == "__main__":
    unittest.main()

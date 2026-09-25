import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import (
    approval_resume,
    config,
    db,
    gmail_write,
    inbox_api,
    integration_adapters,
    integrations,
    mutation_tool_planner,
    orchestrator,
)
from app.core import TOOLS


class GmailDraftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.core_db = str(base / "core.sqlite3")
        self.inbox_db = str(base / "inbox.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.core_db))
        self.inbox_patch = patch.object(inbox_api, "INBOX_DB", self.inbox_db)
        self.db_patch.start()
        self.inbox_patch.start()
        db.initialise()
        inbox_api.initialise()

    def tearDown(self):
        self.inbox_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    def _settings(self, *, enabled: bool):
        return replace(
            config.settings,
            gmail_client_id="read-client",
            gmail_client_secret="read-secret",
            gmail_refresh_token="read-refresh",
            gmail_user_id="me",
            gmail_write_client_id="write-client",
            gmail_write_client_secret="write-secret",
            gmail_write_refresh_token="write-refresh",
            gmail_write_user_id="me",
            gmail_write_enabled=enabled,
        )

    def test_draft_fields_are_strict_and_readback_must_match(self):
        self.assertEqual(gmail_write._recipient("person@example.com"), "person@example.com")
        with self.assertRaises(ValueError):
            gmail_write._recipient("Person <person@example.com>")
        with self.assertRaises(ValueError):
            gmail_write._recipient("one@example.com,two@example.com")
        with self.assertRaises(ValueError):
            gmail_write._subject("hello\nBcc: bad@example.com")
        with self.assertRaises(ValueError):
            gmail_write._body("x" * (gmail_write.MAX_BODY_CHARS + 1))

        raw = gmail_write._raw_message("person@example.com", "Hello", "Plain body")
        verified = gmail_write._verified_draft(
            {"message": {"id": "message-1", "raw": raw}},
            expected_to="person@example.com",
            expected_subject="Hello",
            expected_body="Plain body",
            draft_id="draft-1",
        )
        self.assertTrue(verified["verified"])
        self.assertEqual(verified["body_chars"], len("Plain body"))

        with self.assertRaises(RuntimeError):
            gmail_write._verified_draft(
                {"message": {"id": "message-1", "raw": raw}},
                expected_to="other@example.com",
                expected_subject="Hello",
                expected_body="Plain body",
                draft_id="draft-1",
            )

    def test_write_gate_blocks_draft_before_approval(self):
        disabled = self._settings(enabled=False)
        with patch.object(config, "settings", disabled):
            gmail = integrations.get_integration("gmail")
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="Create email draft to person@example.com subject: Hello body: Plain body",
                conversation_id="draft-off",
            ))
        capability = next(item for item in gmail["capabilities"] if item["action"] == "email.draft.create")
        self.assertFalse(capability["enabled"])
        self.assertEqual(result["decision"], "denied")
        self.assertIn("write capability is disabled", result["reason"])
        with db.connection() as connection:
            approvals = connection.execute(
                "SELECT COUNT(*) FROM approvals WHERE request_id = ?", (result["request_id"],)
            ).fetchone()[0]
        self.assertEqual(approvals, 0)

    def test_enabled_draft_still_requires_approval_then_executes_once(self):
        enabled = self._settings(enabled=True)
        adapter = AsyncMock(return_value={
            "ok": True,
            "draft": {
                "id": "draft-123",
                "message_id": "message-123",
                "to": "person@example.com",
                "subject": "Hello",
                "body_chars": len("Plain body"),
                "verified": True,
            },
        })
        with (
            patch.object(config, "settings", enabled),
            patch.object(integration_adapters, "gmail_create_draft", new=adapter),
        ):
            proposed = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="Create email draft to person@example.com subject: Hello body: Plain body",
                conversation_id="draft-on",
            ))
            self.assertEqual(proposed["decision"], "approval_required")
            self.assertEqual(proposed["tool_action"], "email.draft.create")
            self.assertEqual(proposed["approval"]["risk_level"], "external")
            self.assertEqual(adapter.await_count, 0)

            approval_id = proposed["approval"]["id"]
            completed = asyncio.run(approval_resume.resolve_and_resume(approval_id, True))
            self.assertEqual(completed["state"], "completed")
            self.assertTrue(completed["execution"]["verification"]["ok"])
            self.assertEqual(completed["execution"]["verification"]["method"], "email_draft")
            self.assertEqual(adapter.await_count, 1)
            adapter.assert_awaited_once_with("person@example.com", "Hello", "Plain body")

            replay = asyncio.run(approval_resume.resolve_and_resume(approval_id, True))
            self.assertEqual(replay["state"], "completed")
            self.assertTrue(replay["execution"].get("replayed"))
            self.assertEqual(adapter.await_count, 1)

        with db.connection() as connection:
            executions = connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE request_id = ? AND action = 'email.draft.create'",
                (proposed["request_id"],),
            ).fetchone()[0]
        self.assertEqual(executions, 1)

    def test_planner_requires_recipient_subject_and_body_and_never_plans_send(self):
        good = mutation_tool_planner.plan_mutation_tool(
            "Create email draft to person@example.com subject: Hello body: Plain body"
        )
        self.assertEqual(good.action, "email.draft.create")
        self.assertEqual(good.arguments, {
            "to": "person@example.com",
            "subject": "Hello",
            "body": "Plain body",
        })
        self.assertIsNone(mutation_tool_planner.plan_mutation_tool(
            "Create email draft to person@example.com subject: Hello"
        ))
        self.assertIsNone(mutation_tool_planner.plan_mutation_tool(
            "Create email draft to not-an-email subject: Hello body: Plain body"
        ))
        self.assertIsNone(mutation_tool_planner.plan_mutation_tool(
            "Send email to person@example.com subject: Hello body: Plain body"
        ))
        self.assertNotIn("email.send", TOOLS)
        self.assertNotIn("email.send", integration_adapters.registered_actions())

    def test_registry_does_not_expose_draft_credentials_or_body(self):
        enabled = self._settings(enabled=True)
        with patch.object(config, "settings", enabled):
            registry = integrations.integration_registry()
        serialized = str(registry)
        for secret in ("write-client", "write-secret", "write-refresh"):
            self.assertNotIn(secret, serialized)
        self.assertNotIn("Plain body", serialized)


if __name__ == "__main__":
    unittest.main()

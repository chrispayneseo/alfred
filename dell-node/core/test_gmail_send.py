import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import (
    approval_resume,
    config,
    db,
    execution,
    gmail_write,
    inbox_api,
    integration_adapters,
    mutation_tool_planner,
    orchestrator,
)
from app.core import decide


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class _GmailClient:
    def __init__(self, raw_payload, sent_payload=None):
        self.raw_payload = raw_payload
        self.sent_payload = sent_payload or {"id": "sent-message-1"}
        self.get_calls = []
        self.post_calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        return _Response(self.raw_payload)

    async def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        return _Response(self.sent_payload)


class GmailReviewedSendTests(unittest.TestCase):
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
        execution.initialise_execution_store()
        inbox_api.initialise()

    def tearDown(self):
        self.inbox_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    def _settings(self, *, send_enabled: bool):
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
            gmail_write_enabled=True,
            gmail_send_enabled=send_enabled,
        )

    def _seed_verified_draft(self, draft_id="draft-123", *, body="Plain body"):
        arguments = {
            "to": "person@example.com",
            "subject": "Hello",
            "body": body,
        }
        result = {
            "ok": True,
            "draft": {
                "id": draft_id,
                "message_id": "draft-message-1",
                "to": arguments["to"],
                "subject": arguments["subject"],
                "body_chars": len(body),
                "verified": True,
            },
        }
        verification = {
            "ok": True,
            "method": "email_draft",
            "draft_id": draft_id,
        }
        with db.connection() as connection:
            connection.execute(
                """INSERT INTO core_executions
                   (id, request_id, plan_id, step_index, action, state, arguments,
                    result, verification, completed_at)
                   VALUES (?, ?, ?, ?, 'email.draft.create', 'completed', ?, ?, ?, CURRENT_TIMESTAMP)""",
                (
                    f"create-{draft_id}",
                    f"request-{draft_id}",
                    f"mutation:request-{draft_id}",
                    0,
                    json.dumps(arguments),
                    json.dumps(result),
                    json.dumps(verification),
                ),
            )
        return arguments

    def test_send_planner_is_draft_id_only_and_high_impact(self):
        plan = mutation_tool_planner.plan_mutation_tool("Send email draft draft-123")
        self.assertEqual(plan.action, "email.draft.send")
        self.assertEqual(plan.arguments, {"draft_id": "draft-123"})
        self.assertEqual(decide("email.draft.send").level, "high_impact")
        self.assertEqual(decide("email.draft.send").decision, "confirm")
        self.assertIsNone(mutation_tool_planner.plan_mutation_tool(
            "Send email to person@example.com subject: Hello body: Plain body"
        ))
        self.assertIsNone(mutation_tool_planner.plan_mutation_tool("Send email draft bad/id"))

    def test_send_gate_denies_before_approval(self):
        settings = self._settings(send_enabled=False)
        with patch.object(config, "settings", settings):
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="Send email draft draft-123",
                conversation_id="send-gate-off",
            ))
        self.assertEqual(result["decision"], "denied")
        self.assertIn("write capability is disabled", result["reason"])
        with db.connection() as connection:
            approvals = connection.execute(
                "SELECT COUNT(*) FROM approvals WHERE request_id = ?", (result["request_id"],)
            ).fetchone()[0]
        self.assertEqual(approvals, 0)

    def test_unknown_draft_is_rejected_before_network_access(self):
        settings = self._settings(send_enabled=True)
        token = AsyncMock(side_effect=AssertionError("network token must not be requested"))
        with (
            patch.object(config, "settings", settings),
            patch.object(gmail_write, "_access_token", new=token),
        ):
            with self.assertRaises(PermissionError):
                asyncio.run(gmail_write.send_draft("unknown-draft"))
        self.assertEqual(token.await_count, 0)

    def test_live_draft_change_is_rejected_before_send_post(self):
        approved = self._seed_verified_draft()
        changed_raw = gmail_write._raw_message(
            approved["to"], approved["subject"], "Changed after approval"
        )
        client = _GmailClient({
            "message": {"id": "draft-message-1", "raw": changed_raw}
        })
        settings = self._settings(send_enabled=True)
        with (
            patch.object(config, "settings", settings),
            patch.object(gmail_write, "_access_token", new=AsyncMock(return_value="token")),
            patch.object(gmail_write.httpx, "AsyncClient", return_value=client),
        ):
            with self.assertRaises(RuntimeError):
                asyncio.run(gmail_write.send_draft("draft-123"))
        self.assertEqual(len(client.get_calls), 1)
        self.assertEqual(client.post_calls, [])

    def test_unchanged_verified_draft_can_be_sent(self):
        approved = self._seed_verified_draft()
        raw = gmail_write._raw_message(
            approved["to"], approved["subject"], approved["body"]
        )
        client = _GmailClient(
            {"message": {"id": "draft-message-1", "raw": raw}},
            {"id": "sent-message-99"},
        )
        settings = self._settings(send_enabled=True)
        with (
            patch.object(config, "settings", settings),
            patch.object(gmail_write, "_access_token", new=AsyncMock(return_value="token")),
            patch.object(gmail_write.httpx, "AsyncClient", return_value=client),
        ):
            result = asyncio.run(gmail_write.send_draft("draft-123"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["sent"]["draft_id"], "draft-123")
        self.assertEqual(result["sent"]["message_id"], "sent-message-99")
        self.assertTrue(result["sent"]["verified_before_send"])
        self.assertEqual(len(client.get_calls), 1)
        self.assertEqual(len(client.post_calls), 1)
        self.assertTrue(client.post_calls[0][0].endswith("/drafts/send"))
        self.assertEqual(client.post_calls[0][1]["json"], {"id": "draft-123"})

    def test_high_impact_approval_resumes_once_and_replays_on_retry(self):
        settings = self._settings(send_enabled=True)
        adapter = AsyncMock(return_value={
            "ok": True,
            "sent": {
                "draft_id": "draft-123",
                "message_id": "sent-message-1",
                "to": "person@example.com",
                "subject": "Hello",
                "verified_before_send": True,
            },
        })
        with (
            patch.object(config, "settings", settings),
            patch.object(integration_adapters, "gmail_send_draft", new=adapter),
        ):
            proposed = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="Send email draft draft-123",
                conversation_id="send-reviewed",
            ))
            self.assertEqual(proposed["decision"], "approval_required")
            self.assertEqual(proposed["tool_action"], "email.draft.send")
            self.assertEqual(proposed["approval"]["risk_level"], "high_impact")
            self.assertEqual(adapter.await_count, 0)

            approval_id = proposed["approval"]["id"]
            completed = asyncio.run(approval_resume.resolve_and_resume(approval_id, True))
            self.assertEqual(completed["state"], "completed")
            self.assertTrue(completed["execution"]["verification"]["ok"])
            self.assertEqual(completed["execution"]["verification"]["method"], "email_sent")
            self.assertEqual(adapter.await_count, 1)

            replay = asyncio.run(approval_resume.resolve_and_resume(approval_id, True))
            self.assertEqual(replay["state"], "completed")
            self.assertTrue(replay["execution"].get("replayed"))
            self.assertEqual(adapter.await_count, 1)

        with db.connection() as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE request_id = ? AND action = 'email.draft.send'",
                (proposed["request_id"],),
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_completed_send_is_marked_non_retryable_for_new_send_guard(self):
        execution.initialise_execution_store()
        with db.connection() as connection:
            connection.execute(
                """INSERT INTO core_executions
                   (id, request_id, plan_id, step_index, action, state, arguments,
                    result, verification, completed_at)
                   VALUES ('send-exec', 'send-req', 'mutation:send-req', 0,
                           'email.draft.send', 'completed', ?, ?, ?, CURRENT_TIMESTAMP)""",
                (
                    json.dumps({"draft_id": "draft-123"}),
                    json.dumps({"ok": True, "sent": {"draft_id": "draft-123"}}),
                    json.dumps({"ok": True, "method": "email_sent"}),
                ),
            )
        self.assertTrue(gmail_write._already_sent_by_alfred("draft-123"))


if __name__ == "__main__":
    unittest.main()

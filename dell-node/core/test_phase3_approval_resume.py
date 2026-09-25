import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import db, inbox_api, main, task_service


async def _noop_loop():
    return None


class Phase3ApprovalResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.core_db = str(base / "core.sqlite3")
        self.inbox_db = str(base / "inbox.sqlite3")

        self.db_settings = patch.object(
            db,
            "settings",
            replace(db.settings, sqlite_path=self.core_db),
        )
        self.main_settings = patch.object(
            main,
            "settings",
            replace(main.settings, api_key="phase3-key"),
        )
        self.inbox_path = patch.object(inbox_api, "INBOX_DB", self.inbox_db)
        self.triage_loop = patch.object(inbox_api, "triage_loop", new=_noop_loop)
        self.reminder_loop = patch.object(inbox_api, "reminder_loop", new=_noop_loop)

        self.db_settings.start()
        self.main_settings.start()
        self.inbox_path.start()
        self.triage_loop.start()
        self.reminder_loop.start()

        self.client_context = TestClient(main.app)
        self.client = self.client_context.__enter__()
        self.headers = {"x-alfred-key": "phase3-key"}

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.reminder_loop.stop()
        self.triage_loop.stop()
        self.inbox_path.stop()
        self.main_settings.stop()
        self.db_settings.stop()
        self.temp.cleanup()

    def _propose_task(self, title: str = "renew passport") -> dict:
        response = self.client.post(
            "/v1/requests",
            headers=self.headers,
            json={
                "channel": "api",
                "message": f"Add task: {title}",
                "conversation_id": "phase3-approval",
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["decision"], "approval_required")
        self.assertEqual(payload["tool_action"], "tasks.create")
        self.assertEqual(payload["approval"]["state"], "pending")
        return payload

    def test_approval_executes_bound_task_once_and_retry_replays(self):
        proposal = self._propose_task()
        approval_id = proposal["approval"]["id"]
        request_id = proposal["request_id"]

        self.assertEqual(task_service.list_items(kind="task"), [])
        with db.connection() as connection:
            stored = connection.execute(
                """SELECT plan_id, step_index, action, state FROM resumable_tool_proposals
                   WHERE approval_id = ?""",
                (approval_id,),
            ).fetchone()
        self.assertIsNotNone(stored)
        self.assertEqual(stored["plan_id"], f"mutation:{request_id}")
        self.assertEqual(stored["step_index"], 0)
        self.assertEqual(stored["action"], "tasks.create")
        self.assertEqual(stored["state"], "pending")

        approved = self.client.post(
            f"/v1/core/approvals/{approval_id}",
            headers=self.headers,
            json={"approved": True},
        )
        self.assertEqual(approved.status_code, 200)
        approved_payload = approved.json()
        self.assertEqual(approved_payload["state"], "completed")
        self.assertTrue(approved_payload["resumed"])
        self.assertTrue(approved_payload["execution"]["verification"]["ok"])
        self.assertEqual(approved_payload["reply"], "Done — I created the task.")

        items = task_service.list_items(kind="task")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "renew passport")

        lifecycle = self.client.get(
            f"/v1/core/requests/{request_id}", headers=self.headers
        ).json()
        self.assertEqual(lifecycle["request"]["state"], "completed")
        self.assertIn(
            "approval.resumed_completed",
            [item["event_type"] for item in lifecycle["timeline"]],
        )

        replay = self.client.post(
            f"/v1/core/approvals/{approval_id}",
            headers=self.headers,
            json={"approved": True},
        )
        self.assertEqual(replay.status_code, 200)
        replay_payload = replay.json()
        self.assertEqual(replay_payload["state"], "completed")
        self.assertTrue(replay_payload["execution"].get("replayed"))
        self.assertEqual(len(task_service.list_items(kind="task")), 1)

        with db.connection() as connection:
            executions = connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE request_id = ? AND action = 'tasks.create'",
                (request_id,),
            ).fetchone()[0]
            approval = connection.execute(
                "SELECT state FROM approvals WHERE id = ?", (approval_id,)
            ).fetchone()
            proposal_state = connection.execute(
                "SELECT state FROM resumable_tool_proposals WHERE approval_id = ?", (approval_id,)
            ).fetchone()
        self.assertEqual(executions, 1)
        self.assertEqual(approval["state"], "approved")
        self.assertEqual(proposal_state["state"], "completed")

    def test_rejection_never_executes_and_opposite_retry_conflicts(self):
        proposal = self._propose_task("cancel me")
        approval_id = proposal["approval"]["id"]
        request_id = proposal["request_id"]

        rejected = self.client.post(
            f"/v1/core/approvals/{approval_id}",
            headers=self.headers,
            json={"approved": False},
        )
        self.assertEqual(rejected.status_code, 200)
        payload = rejected.json()
        self.assertEqual(payload["state"], "rejected")
        self.assertFalse(payload["resumed"])
        self.assertEqual(task_service.list_items(kind="task"), [])

        lifecycle = self.client.get(
            f"/v1/core/requests/{request_id}", headers=self.headers
        ).json()["request"]
        self.assertEqual(lifecycle["state"], "denied")

        opposite = self.client.post(
            f"/v1/core/approvals/{approval_id}",
            headers=self.headers,
            json={"approved": True},
        )
        self.assertEqual(opposite.status_code, 409)
        self.assertEqual(opposite.json()["detail"]["state"], "conflict")
        self.assertEqual(task_service.list_items(kind="task"), [])

    def test_tampered_proposal_cannot_consume_pending_approval(self):
        proposal = self._propose_task("original title")
        approval_id = proposal["approval"]["id"]

        with db.connection() as connection:
            connection.execute(
                """UPDATE resumable_tool_proposals
                   SET arguments = ? WHERE approval_id = ?""",
                (
                    '{"detail":"","due":null,"kind":"task","title":"tampered title"}',
                    approval_id,
                ),
            )

        response = self.client.post(
            f"/v1/core/approvals/{approval_id}",
            headers=self.headers,
            json={"approved": True},
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["state"], "scope_mismatch")
        self.assertEqual(task_service.list_items(kind="task"), [])

        with db.connection() as connection:
            approval = connection.execute(
                "SELECT state FROM approvals WHERE id = ?", (approval_id,)
            ).fetchone()
        self.assertEqual(approval["state"], "pending")

    def test_non_resumable_approval_keeps_resolve_only_compatibility(self):
        created = self.client.post(
            "/v1/core/approvals",
            headers=self.headers,
            json={
                "request_id": "legacy-approval-request",
                "action": "memory.write",
                "summary": "Legacy manual approval",
                "risk_level": "safe_write",
            },
        )
        self.assertEqual(created.status_code, 200)
        approval_id = created.json()["id"]

        resolved = self.client.post(
            f"/v1/core/approvals/{approval_id}",
            headers=self.headers,
            json={"approved": True},
        )
        self.assertEqual(resolved.status_code, 200)
        self.assertEqual(resolved.json(), {
            "id": approval_id,
            "state": "approved",
            "resumed": False,
        })


if __name__ == "__main__":
    unittest.main()

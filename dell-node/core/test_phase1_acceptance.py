import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import cloud_execution, db, inbox_api, main, providers


async def _noop_loop():
    return None


class Phase1AcceptanceTests(unittest.TestCase):
    """HTTP-level acceptance tests for the authoritative Phase 1 Core boundary."""

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
            replace(main.settings, api_key="acceptance-key"),
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
        self.headers = {"x-alfred-key": "acceptance-key"}

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.reminder_loop.stop()
        self.triage_loop.stop()
        self.inbox_path.stop()
        self.main_settings.stop()
        self.db_settings.stop()
        self.temp.cleanup()

    def test_core_endpoints_require_owner_authentication(self):
        response = self.client.get("/v1/core/status")
        self.assertEqual(response.status_code, 401)

        authorised = self.client.get("/v1/core/status", headers=self.headers)
        self.assertEqual(authorised.status_code, 200)
        self.assertEqual(authorised.json()["status"], "ok")

    def test_legacy_memory_write_runs_through_approval_execution_and_verification(self):
        proposal = self.client.post(
            "/v1/memories",
            headers=self.headers,
            json={"kind": "note", "content": "Phase 1 acceptance note", "confirmed": False},
        )
        self.assertEqual(proposal.status_code, 409)
        self.assertEqual(db.list_memories(), [])

        saved = self.client.post(
            "/v1/memories",
            headers=self.headers,
            json={"kind": "note", "content": "Phase 1 acceptance note", "confirmed": True},
        )
        self.assertEqual(saved.status_code, 200)
        memory_id = saved.json()["id"]

        read = self.client.get(f"/v1/memories/{memory_id}", headers=self.headers)
        self.assertEqual(read.status_code, 200)
        self.assertEqual(read.json()["content"], "Phase 1 acceptance note")

        executions = self.client.get("/v1/core/executions", headers=self.headers).json()["items"]
        memory_writes = [item for item in executions if item["action"] == "memory.write"]
        self.assertEqual(len(memory_writes), 1)
        self.assertEqual(memory_writes[0]["state"], "completed")
        self.assertTrue(memory_writes[0]["verification"]["ok"])

        with db.connection() as connection:
            approval = connection.execute(
                "SELECT state, scope_hash FROM approvals WHERE action = 'memory.write' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        self.assertEqual(approval["state"], "approved")
        self.assertTrue(approval["scope_hash"])

    def test_private_cloud_request_requires_approval_then_completes_same_lifecycle(self):
        provider_settings = replace(
            providers.settings,
            openai_api_key="acceptance-openai-key",
            openai_model="gpt-5.6-terra",
        )
        cloud_result = {
            "provider": "openai",
            "model": "gpt-5.6-terra",
            "reply": "Your warranty research is complete.",
            "usage": {"input_tokens": 14, "output_tokens": 7},
            "web_search": True,
        }
        prompt = "Research my boiler warranty online"

        with patch.object(providers, "settings", provider_settings), patch.object(
            cloud_execution,
            "cloud_complete",
            new=AsyncMock(return_value=cloud_result),
        ) as complete:
            first = self.client.post(
                "/v1/requests",
                headers=self.headers,
                json={"channel": "api", "message": prompt},
            )
            self.assertEqual(first.status_code, 200)
            first_payload = first.json()
            self.assertEqual(first_payload["decision"], "approval_required")
            self.assertEqual(first_payload["provider"], "openai")
            self.assertFalse(first_payload["memory_sent"])
            request_id = first_payload["request_id"]

            resumed = self.client.post(
                "/v1/core/cloud/execute",
                headers=self.headers,
                json={
                    "request_id": request_id,
                    "prompt": prompt,
                    "provider": "openai",
                    "confirmed": True,
                },
            )
            self.assertEqual(resumed.status_code, 200)
            resumed_payload = resumed.json()
            self.assertEqual(resumed_payload["state"], "completed")
            self.assertEqual(resumed_payload["reply"], "Your warranty research is complete.")
            self.assertFalse(resumed_payload["memory_sent"])

            lifecycle = self.client.get(
                f"/v1/core/requests/{request_id}", headers=self.headers
            )
            self.assertEqual(lifecycle.status_code, 200)
            lifecycle_payload = lifecycle.json()
            self.assertEqual(lifecycle_payload["request"]["state"], "completed")
            timeline = lifecycle_payload["timeline"]
            timeline_types = [item["event_type"] for item in timeline]
            self.assertTrue(any(
                item["event_type"] == "request.routed"
                and item["data"].get("decision") == "approval_required"
                for item in timeline
            ))
            self.assertIn("approval.resolved", timeline_types)
            self.assertIn("cloud.completed", timeline_types)

            complete.assert_awaited_once()

        with db.connection() as connection:
            approval = connection.execute(
                "SELECT state, scope_hash, summary FROM approvals WHERE request_id = ? AND action = 'provider.openai'",
                (request_id,),
            ).fetchone()
            audit_types = [
                row["event_type"]
                for row in connection.execute(
                    "SELECT event_type FROM audit_events WHERE request_id = ? ORDER BY occurred_at, rowid",
                    (request_id,),
                ).fetchall()
            ]
        self.assertEqual(approval["state"], "approved")
        self.assertTrue(approval["scope_hash"])
        self.assertNotIn("boiler warranty", approval["summary"].lower())
        self.assertIn("cloud.completed", audit_types)

    def test_provider_health_endpoint_exposes_state_not_credentials(self):
        health = [
            {"name": "ollama.chat", "configured": True, "reachable": True, "state": "ready"},
            {"name": "openai", "configured": False, "reachable": False, "state": "disabled"},
        ]
        with patch.object(main, "provider_health", new=AsyncMock(return_value=health)):
            response = self.client.get("/v1/core/providers/health", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["providers"], health)
        self.assertNotIn("api_key", str(payload).lower())


if __name__ == "__main__":
    unittest.main()

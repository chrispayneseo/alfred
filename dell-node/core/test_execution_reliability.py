import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, execution, execution_reliability, recovery


class ExecutionReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.db_path = str(base / "core.sqlite3")
        self.patch_db_settings = patch.object(
            db, "settings", replace(db.settings, sqlite_path=self.db_path)
        )
        self.patch_execution_connection = patch.object(execution, "connection", db.connection)
        self.patch_recovery_connection = patch.object(recovery, "connection", db.connection)
        self.patch_reliability_connection = patch.object(
            execution_reliability, "connection", db.connection
        )
        self.patch_db_settings.start()
        self.patch_execution_connection.start()
        self.patch_recovery_connection.start()
        self.patch_reliability_connection.start()
        db.initialise()
        execution.initialise_execution_store()
        recovery.initialise_recovery_store()
        execution_reliability.initialise()

    def tearDown(self):
        self.patch_reliability_connection.stop()
        self.patch_recovery_connection.stop()
        self.patch_execution_connection.stop()
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_failed_read_retries_within_bound_and_verifies(self):
        calls = {"count": 0}

        async def flaky_invoke(action, arguments, request_id):
            self.assertEqual(action, "memory.read")
            calls["count"] += 1
            if calls["count"] < 3:
                raise RuntimeError("temporary read failure")
            return {"items": []}

        with patch.object(execution, "_invoke", side_effect=flaky_invoke):
            result = asyncio.run(execution.execute_tool(
                request_id="req-5e-read",
                action="memory.read",
                arguments={"query": "bounded retry"},
            ))

        self.assertEqual(result["state"], "completed")
        self.assertTrue(result["verification"]["ok"])
        self.assertEqual(calls["count"], 3)
        self.assertEqual(result["reliability"]["attempts"], 3)
        self.assertEqual(result["reliability"]["recovery"], "verified")
        with db.connection() as connection:
            receipts = connection.execute(
                "SELECT COUNT(*) AS count FROM core_execution_receipts"
            ).fetchone()["count"]
            executions = connection.execute(
                "SELECT COUNT(*) AS count FROM core_executions WHERE request_id = ?",
                ("req-5e-read",),
            ).fetchone()["count"]
        self.assertEqual(receipts, 3)
        self.assertEqual(executions, 1)

    def test_ambiguous_mutation_stops_and_is_not_replayed(self):
        calls = {"count": 0}

        async def ambiguous_mutation(action, arguments, request_id):
            self.assertEqual(action, "memory.candidate.propose")
            calls["count"] += 1
            raise RuntimeError("connection lost after submit")

        arguments = {"content": "Potential durable fact"}
        with patch.object(execution, "_invoke", side_effect=ambiguous_mutation):
            first = asyncio.run(execution.execute_tool(
                request_id="req-5e-write",
                action="memory.candidate.propose",
                arguments=arguments,
            ))
            second = asyncio.run(execution.execute_tool(
                request_id="req-5e-write",
                action="memory.candidate.propose",
                arguments=arguments,
            ))

        self.assertEqual(first["state"], "reconciliation_required")
        self.assertEqual(second["state"], "reconciliation_required")
        self.assertTrue(second["reliability"]["replay_protected"])
        self.assertEqual(calls["count"], 1)
        with db.connection() as connection:
            executions = connection.execute(
                "SELECT COUNT(*) AS count FROM core_executions WHERE request_id = ?",
                ("req-5e-write",),
            ).fetchone()["count"]
        self.assertEqual(executions, 1)

    def test_restart_classifies_reads_and_mutations_without_replay(self):
        rows = [
            (
                "exec-read-interrupted", "req-restart", None, None, "memory.read",
                json.dumps({"query": "resume me"}),
            ),
            (
                "exec-write-interrupted", "req-restart", None, None,
                "memory.candidate.propose", json.dumps({"content": "do not replay"}),
            ),
        ]
        with db.connection() as connection:
            connection.executemany("""INSERT INTO core_executions
                (id, request_id, plan_id, step_index, action, state, arguments, error)
                VALUES (?, ?, ?, ?, ?, 'interrupted', ?, 'Core process interrupted')""", rows)

        classified = execution_reliability.reconcile_interrupted_operations()
        self.assertEqual(classified["retryable"], 1)
        self.assertEqual(classified["reconciliation_required"], 1)
        with db.connection() as connection:
            states = {
                row["action"]: row["state"]
                for row in connection.execute(
                    "SELECT action, state FROM core_reliability_operations"
                ).fetchall()
            }
        self.assertEqual(states["memory.read"], "retryable")
        self.assertEqual(
            states["memory.candidate.propose"], "reconciliation_required"
        )

    def test_status_is_content_minimised(self):
        secret = "private-message-that-must-not-leak"
        key = execution_reliability.operation_key(
            request_id="req-status",
            action="memory.read",
            arguments={"query": secret},
            plan_id=None,
            step_index=None,
        )
        execution_reliability._upsert_operation(
            key=key,
            request_id="req-status",
            plan_id=None,
            step_index=None,
            action="memory.read",
            arguments={"query": secret},
            state="retryable",
        )
        state = execution_reliability.status()
        encoded = json.dumps(state)
        self.assertNotIn(secret, encoded)
        self.assertEqual(state["mode"], "verified_execution_recovery_v1")
        self.assertEqual(state["max_read_attempts"], 3)
        self.assertTrue(state["automatic_read_retries"])
        self.assertTrue(state["mutation_replay_protection"])
        self.assertTrue(state["metadata_only_receipts"])
        self.assertFalse(state["cloud_models"])


if __name__ == "__main__":
    unittest.main()

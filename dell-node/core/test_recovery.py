import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import db, execution, inbox_api, recovery


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.db_path = str(base / "core.sqlite3")
        self.patch_db_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.patch_execution_connection = patch.object(execution, "connection", db.connection)
        self.patch_recovery_connection = patch.object(recovery, "connection", db.connection)
        self.patch_inbox_path = patch.object(inbox_api, "INBOX_DB", str(base / "inbox.sqlite3"))
        self.patch_db_settings.start()
        self.patch_execution_connection.start()
        self.patch_recovery_connection.start()
        self.patch_inbox_path.start()
        db.initialise()
        inbox_api.initialise()
        execution.initialise_execution_store()
        recovery.initialise_recovery_store()

    def tearDown(self):
        self.patch_inbox_path.stop()
        self.patch_recovery_connection.stop()
        self.patch_execution_connection.stop()
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def _insert_execution(self, *, execution_id, request_id, action, arguments,
                          state="failed", plan_id=None, step_index=None):
        with db.connection() as connection:
            connection.execute(
                """INSERT INTO core_executions
                   (id, request_id, plan_id, step_index, action, state, arguments, error)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (execution_id, request_id, plan_id, step_index, action, state,
                 json.dumps(arguments, separators=(",", ":")), "test failure"),
            )

    def test_startup_marks_running_work_interrupted(self):
        plan = db.create_plan("req-restart", "Read saved state", [
            {"action": "memory.read", "arguments": {"query": "saved state"}}
        ])
        with db.connection() as connection:
            connection.execute("UPDATE plans SET state = 'running' WHERE id = ?", (plan["id"],))
        self._insert_execution(
            execution_id="exec-running", request_id="req-restart", action="memory.read",
            arguments={"query": "saved state"}, state="running",
            plan_id=plan["id"], step_index=0,
        )

        recovered = recovery.recover_interrupted_work()
        self.assertEqual(recovered, {"executions": 1, "plans": 1})
        item = recovery.get_recovery_item("exec-running")
        self.assertEqual(item["state"], "interrupted")
        self.assertEqual(item["recovery"], "retryable")
        with db.connection() as connection:
            plan_state = connection.execute("SELECT state FROM plans WHERE id = ?", (plan["id"],)).fetchone()["state"]
        self.assertEqual(plan_state, "interrupted")

    def test_failed_read_can_be_retried_and_verified(self):
        db.remember("note", "Recovery note is in the blue folder", "test")
        self._insert_execution(
            execution_id="exec-read", request_id="req-read-retry", action="memory.read",
            arguments={"query": "recovery note"},
        )

        result = asyncio.run(recovery.retry_execution("exec-read"))
        self.assertEqual(result["id"], "exec-read")
        self.assertEqual(result["state"], "completed")
        self.assertTrue(result["verification"]["ok"])
        self.assertEqual(result["verification"]["method"], "read_result")
        with db.connection() as connection:
            attempt = connection.execute(
                "SELECT state FROM core_recovery_attempts WHERE execution_id = ?",
                ("exec-read",),
            ).fetchone()
        self.assertEqual(attempt["state"], "completed")

    def test_failed_mutation_requires_reconciliation_and_is_not_replayed(self):
        self._insert_execution(
            execution_id="exec-write", request_id="req-write-recovery", action="memory.write",
            arguments={"kind": "note", "content": "Do not replay me"},
        )

        result = asyncio.run(recovery.retry_execution("exec-write"))
        self.assertEqual(result["recovery"], "reconcile_required")
        self.assertEqual(db.list_memories(), [])
        with db.connection() as connection:
            attempts = connection.execute(
                "SELECT COUNT(*) AS count FROM core_recovery_attempts WHERE execution_id = ?",
                ("exec-write",),
            ).fetchone()["count"]
        self.assertEqual(attempts, 0)

    def test_retried_plan_read_can_then_resume_without_duplicate_execution(self):
        db.remember("note", "Plan recovery evidence", "test")
        plan = db.create_plan("req-plan-retry", "Recover read", [
            {"action": "memory.read", "arguments": {"query": "recovery evidence"}}
        ])
        self._insert_execution(
            execution_id="exec-plan-read", request_id="req-plan-retry", action="memory.read",
            arguments={"query": "recovery evidence"}, plan_id=plan["id"], step_index=0,
        )

        retried = asyncio.run(recovery.retry_execution("exec-plan-read"))
        self.assertEqual(retried["state"], "completed")
        resumed = asyncio.run(execution.execute_plan(plan["id"]))
        self.assertEqual(resumed["state"], "completed")
        self.assertEqual(resumed["executions"][0]["id"], "exec-plan-read")
        self.assertTrue(resumed["executions"][0]["replayed"])
        with db.connection() as connection:
            count = connection.execute(
                "SELECT COUNT(*) AS count FROM core_executions WHERE plan_id = ? AND step_index = 0",
                (plan["id"],),
            ).fetchone()["count"]
        self.assertEqual(count, 1)

    def test_recovery_summary_separates_retryable_from_reconciliation(self):
        self._insert_execution(
            execution_id="exec-summary-read", request_id="req-summary", action="memory.read",
            arguments={"query": "anything"},
        )
        self._insert_execution(
            execution_id="exec-summary-ha", request_id="req-summary", action="home_assistant.service",
            arguments={"service": "light.turn_on", "entity_id": "light.study"}, state="interrupted",
        )
        summary = recovery.recovery_summary()
        self.assertEqual(summary["counts"]["retryable"], 1)
        self.assertEqual(summary["counts"]["reconcile_required"], 1)


if __name__ == "__main__":
    unittest.main()

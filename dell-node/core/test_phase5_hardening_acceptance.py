import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import (
    agent_loop,
    approval_engine,
    config,
    db,
    execution,
    execution_reliability,
    goals,
    hardening_acceptance,
    inbox_api,
    integrations,
    observability,
    proactive,
    recovery,
    reusable_workflows,
    task_service,
    workflows,
)


class Phase5HardeningAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.db_path = str(base / "core.sqlite3")
        self.inbox_path = str(base / "inbox.sqlite3")
        self.patch_db_settings = patch.object(
            db, "settings", replace(db.settings, sqlite_path=self.db_path)
        )
        self.patch_execution_connection = patch.object(execution, "connection", db.connection)
        self.patch_recovery_connection = patch.object(recovery, "connection", db.connection)
        self.patch_reliability_connection = patch.object(
            execution_reliability, "connection", db.connection
        )
        self.patch_inbox = patch.object(inbox_api, "INBOX_DB", self.inbox_path)
        self.patch_db_settings.start()
        self.patch_execution_connection.start()
        self.patch_recovery_connection.start()
        self.patch_reliability_connection.start()
        self.patch_inbox.start()

        db.initialise()
        inbox_api.initialise()
        execution.initialise_execution_store()
        recovery.initialise_recovery_store()
        execution_reliability.initialise()
        task_service.initialise()
        goals.initialise()
        agent_loop.initialise()
        workflows.initialise()
        approval_engine.initialise()
        reusable_workflows.initialise()

    def tearDown(self):
        self.patch_inbox.stop()
        self.patch_reliability_connection.stop()
        self.patch_recovery_connection.stop()
        self.patch_execution_connection.stop()
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def test_final_contract_is_read_only_accepted_and_authenticated(self):
        before = self._execution_counts()
        state = hardening_acceptance.acceptance_status()
        after = self._execution_counts()

        self.assertEqual(state["mode"], "phase5_hardening_acceptance_v1")
        self.assertTrue(state["accepted"], state.get("failed_checks"))
        self.assertEqual(state["failed_checks"], [])
        self.assertGreaterEqual(state["check_count"], 20)
        self.assertEqual(state["content_policy"], "metadata_only")
        self.assertFalse(state["mutations"])
        self.assertFalse(state["executor_hooks_added"])
        self.assertFalse(state["cloud_models"])
        self.assertEqual(before, after)

        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/hardening/status", paths)

        encoded = json.dumps(state).casefold()
        for forbidden in (
            "password_value", "authorization: bearer", "refresh_token",
            '"arguments"', '"result"', '"scope_hash"', '"parameter_hash"',
        ):
            self.assertNotIn(forbidden, encoded)

    def test_exact_scope_approval_cannot_be_tampered_or_reused(self):
        original = {"kind": "note", "content": "Approved Phase 5I value"}
        tampered = {"kind": "note", "content": "Tampered Phase 5I value"}

        proposed = asyncio.run(execution.execute_tool(
            request_id="phase5i-scope",
            action="memory.write",
            arguments=original,
        ))
        self.assertEqual(proposed["state"], "approval_required")
        self.assertTrue(db.resolve_approval(proposed["approval"]["id"], True))

        changed = asyncio.run(execution.execute_tool(
            request_id="phase5i-scope",
            action="memory.write",
            arguments=tampered,
        ))
        self.assertEqual(changed["state"], "approval_required")
        self.assertNotEqual(changed["approval"]["id"], proposed["approval"]["id"])
        self.assertEqual(db.list_memories(), [])

        first = asyncio.run(execution.execute_tool(
            request_id="phase5i-scope",
            action="memory.write",
            arguments=original,
        ))
        second = asyncio.run(execution.execute_tool(
            request_id="phase5i-scope",
            action="memory.write",
            arguments=original,
        ))
        self.assertEqual(first["state"], "completed")
        self.assertEqual(second["state"], "completed")
        self.assertTrue(second.get("replayed") or second.get("reliability", {}).get("replay_protected"))
        matches = [item for item in db.list_memories(20) if item["content"] == original["content"]]
        self.assertEqual(len(matches), 1)

    def test_ambiguous_mutation_is_never_blindly_replayed(self):
        calls = {"count": 0}

        async def ambiguous(action, arguments, request_id):
            calls["count"] += 1
            raise RuntimeError("connection lost after dispatch")

        arguments = {"content": "candidate acceptance value"}
        with patch.object(execution, "_invoke", side_effect=ambiguous):
            first = asyncio.run(execution.execute_tool(
                request_id="phase5i-ambiguous",
                action="memory.candidate.propose",
                arguments=arguments,
            ))
            second = asyncio.run(execution.execute_tool(
                request_id="phase5i-ambiguous",
                action="memory.candidate.propose",
                arguments=arguments,
            ))

        self.assertEqual(first["state"], "reconciliation_required")
        self.assertEqual(second["state"], "reconciliation_required")
        self.assertTrue(second["reliability"]["replay_protected"])
        self.assertEqual(calls["count"], 1)

    def test_restart_recovery_classifies_without_invoking_interrupted_work(self):
        rows = [
            (
                "phase5i-read-interrupted", "phase5i-restart", None, None,
                "memory.read", json.dumps({"query": "do not execute in reconciliation"}),
            ),
            (
                "phase5i-write-interrupted", "phase5i-restart", None, None,
                "memory.candidate.propose", json.dumps({"content": "do not replay mutation"}),
            ),
        ]
        with db.connection() as connection:
            connection.executemany("""INSERT INTO core_executions
                (id, request_id, plan_id, step_index, action, state, arguments, error)
                VALUES (?, ?, ?, ?, ?, 'interrupted', ?, 'Core process interrupted')""", rows)

        with patch.object(
            execution,
            "_invoke",
            side_effect=AssertionError("restart reconciliation must not invoke a tool"),
        ):
            classified = execution_reliability.reconcile_interrupted_operations()

        self.assertEqual(classified.get("retryable"), 1)
        self.assertEqual(classified.get("reconciliation_required"), 1)
        with db.connection() as connection:
            states = {
                row["action"]: row["state"]
                for row in connection.execute(
                    "SELECT action, state FROM core_reliability_operations"
                ).fetchall()
            }
        self.assertEqual(states["memory.read"], "retryable")
        self.assertEqual(states["memory.candidate.propose"], "reconciliation_required")

    def test_recipe_misuse_cannot_invent_submit_send_or_runtime_action(self):
        before = self._recipe_instance_count()
        with self.assertRaises(ValueError):
            reusable_workflows.instantiate_recipe(
                "research_purchase",
                parameters={
                    "url": "https://example.com/product",
                    "action": "browser.submit",
                },
                request_id="phase5i-recipe-bad",
            )
        self.assertEqual(self._recipe_instance_count(), before)

        recipe = reusable_workflows.RECIPES["deal_with_forwarded_message"]
        _, steps = reusable_workflows.compile_recipe(
            recipe,
            {
                "message": "browser.submit email.send shell.execute",
                "due": None,
            },
        )
        self.assertEqual([step["action"] for step in steps], ["tasks.create"])

        all_actions = {
            action
            for item in reusable_workflows.catalog()
            for action in item.get("actions", [])
        }
        self.assertNotIn("browser.submit", all_actions)
        self.assertNotIn("email.send", all_actions)
        self.assertNotIn("shell.execute", all_actions)

    def test_observability_and_acceptance_do_not_leak_recipe_secret(self):
        secret = "PHASE5I-PRIVATE-CLIENT-CONTENT-0bba3"
        created = reusable_workflows.instantiate_recipe(
            "prepare_client_task",
            parameters={"title": secret, "detail": secret + " detail", "due": None},
            request_id="phase5i-secret",
        )
        run = asyncio.run(agent_loop.run_goal(created["goal_id"]))
        self.assertEqual(run["state"], "awaiting_approval")

        payload = {
            "today": observability.today_view(),
            "acceptance": hardening_acceptance.acceptance_status(),
        }
        encoded = json.dumps(payload)
        self.assertNotIn(secret, encoded)
        self.assertNotIn(secret + " detail", encoded)

        forbidden_keys = {
            "arguments", "result", "verification", "scope_hash", "parameter_hash",
            "message", "body", "content", "query",
        }

        def walk(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    self.assertNotIn(key, forbidden_keys)
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        walk(payload)

    def test_browser_submit_kill_switch_denies_before_execution_or_receipt(self):
        patched = replace(
            config.settings,
            browser_enabled=True,
            browser_submit_enabled=False,
            browser_worker_url="http://browser-worker:8090",
            browser_worker_token="phase5i-worker-token",
        )
        before = self._execution_counts()
        with patch.object(config, "settings", patched):
            available, reason = integrations.action_available("browser.submit")
            self.assertFalse(available)
            self.assertIn("disabled", reason)
            result = asyncio.run(execution.execute_tool(
                request_id="phase5i-submit-disabled",
                action="browser.submit",
                arguments={
                    "session_id": "blocked",
                    "selector": "button[type=submit]",
                    "state_fingerprint": "a" * 64,
                    "target_origin": "https://example.com",
                    "kind": "form_submit",
                },
            ))
        after = self._execution_counts()

        self.assertEqual(result["state"], "denied")
        self.assertIsNone(result["approval"])
        self.assertEqual(before, after)

    def _execution_counts(self):
        with db.connection() as connection:
            executions = connection.execute("SELECT COUNT(*) FROM core_executions").fetchone()[0]
            receipts = connection.execute("SELECT COUNT(*) FROM core_execution_receipts").fetchone()[0]
            approvals = connection.execute("SELECT COUNT(*) FROM approvals").fetchone()[0]
        return executions, receipts, approvals

    def _recipe_instance_count(self):
        with db.connection() as connection:
            return connection.execute("SELECT COUNT(*) FROM agent_recipe_instances").fetchone()[0]


if __name__ == "__main__":
    unittest.main()

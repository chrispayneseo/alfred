import asyncio
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import config, db, inbox_api, integrations, local_files, orchestrator
from app.core import decide
from app.execution import execute_tool
from app.integration_adapters import registered_actions
from app.read_tool_planner import plan_read_tool


class LocalFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.root = base / "files"
        self.root.mkdir()
        (self.root / "notes").mkdir()
        (self.root / "notes" / "plan.md").write_text(
            "Phase 3 plan\nThe secret search phrase is apricot compass.\n",
            encoding="utf-8",
        )
        (self.root / "readme.txt").write_text("Hello from Alfred files.\n", encoding="utf-8")
        (self.root / ".hidden.txt").write_text("hidden secret", encoding="utf-8")
        (self.root / ".private").mkdir()
        (self.root / ".private" / "secret.txt").write_text("private", encoding="utf-8")
        (self.root / "binary.bin").write_bytes(b"abc\x00def")
        self.outside = base / "outside.txt"
        self.outside.write_text("outside sandbox", encoding="utf-8")
        try:
            (self.root / "escape-link").symlink_to(self.outside)
            self.has_symlink = True
        except OSError:
            self.has_symlink = False

        self.db_path = str(base / "core.sqlite3")
        self.inbox_db = str(base / "inbox.sqlite3")
        self.db_patch = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.inbox_patch = patch.object(inbox_api, "INBOX_DB", self.inbox_db)
        self.db_patch.start()
        self.inbox_patch.start()
        db.initialise()
        inbox_api.initialise()

        self.files_settings = replace(
            config.settings,
            files_enabled=True,
            files_root=str(self.root),
            files_max_read_bytes=4096,
        )

    def tearDown(self):
        self.inbox_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    def test_manifest_policy_and_adapter_are_read_only_and_aligned(self):
        with patch.object(config, "settings", self.files_settings):
            integration = integrations.get_integration("local_files")
            available = {
                action: integrations.action_available(action)[0]
                for action in ("files.list", "files.search", "files.read")
            }
        self.assertTrue(integration["configured"])
        self.assertEqual(integration["boundary"], "local")
        self.assertTrue(all(available.values()))
        actions = {item["action"] for item in integration["capabilities"]}
        self.assertEqual(actions, {"files.list", "files.search", "files.read"})
        self.assertTrue(actions.issubset(registered_actions()))
        for action in actions:
            decision = decide(action)
            self.assertEqual(decision.level, "read")
            self.assertEqual(decision.decision, "auto")
        self.assertNotIn("files.write", registered_actions())
        self.assertNotIn("files.delete", registered_actions())
        self.assertNotIn("files.move", registered_actions())

    def test_unconfigured_files_fail_closed_before_execution(self):
        disabled = replace(config.settings, files_enabled=False, files_root=str(self.root))
        with patch.object(config, "settings", disabled):
            result = asyncio.run(execute_tool(
                request_id="files-disabled",
                action="files.list",
                arguments={"path": ".", "limit": 20},
            ))
        self.assertEqual(result["state"], "denied")
        self.assertIn("not configured", result["error"])
        with db.connection() as connection:
            table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_executions'"
            ).fetchone()
            count = 0 if table is None else connection.execute(
                "SELECT COUNT(*) FROM core_executions WHERE request_id = 'files-disabled'"
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_list_read_and_search_execute_and_verify(self):
        with patch.object(config, "settings", self.files_settings):
            listed = asyncio.run(execute_tool(
                request_id="files-list",
                action="files.list",
                arguments={"path": ".", "limit": 50},
            ))
            read = asyncio.run(execute_tool(
                request_id="files-read",
                action="files.read",
                arguments={"path": "notes/plan.md", "max_chars": 12000},
            ))
            searched = asyncio.run(execute_tool(
                request_id="files-search",
                action="files.search",
                arguments={"query": "apricot compass", "path": ".", "limit": 10},
            ))

        self.assertEqual(listed["state"], "completed")
        self.assertTrue(listed["verification"]["ok"])
        names = {item["name"] for item in listed["result"]["items"]}
        self.assertIn("notes", names)
        self.assertIn("readme.txt", names)
        self.assertNotIn(".hidden.txt", names)
        self.assertNotIn(".private", names)
        self.assertNotIn("escape-link", names)

        self.assertEqual(read["state"], "completed")
        self.assertTrue(read["verification"]["ok"])
        self.assertEqual(read["result"]["path"], "notes/plan.md")
        self.assertIn("apricot compass", read["result"]["content"])

        self.assertEqual(searched["state"], "completed")
        self.assertTrue(searched["verification"]["ok"])
        self.assertEqual(len(searched["result"]["results"]), 1)
        self.assertEqual(searched["result"]["results"][0]["path"], "notes/plan.md")
        self.assertEqual(searched["result"]["results"][0]["line"], 2)

    def test_traversal_absolute_hidden_binary_and_symlink_access_are_rejected(self):
        attempts = [
            ("../outside.txt", "files.read"),
            (str(self.outside), "files.read"),
            (".hidden.txt", "files.read"),
            (".private/secret.txt", "files.read"),
            ("binary.bin", "files.read"),
        ]
        if self.has_symlink:
            attempts.append(("escape-link", "files.read"))

        with patch.object(config, "settings", self.files_settings):
            results = [
                asyncio.run(execute_tool(
                    request_id=f"escape-{index}",
                    action=action,
                    arguments={"path": path, "max_chars": 12000},
                ))
                for index, (path, action) in enumerate(attempts)
            ]
        self.assertTrue(all(item["state"] == "failed" for item in results))
        self.assertTrue(all("outside sandbox" not in str(item) for item in results))
        self.assertTrue(all("hidden secret" not in str(item) for item in results))

    def test_read_and_search_limits_are_bounded(self):
        big = self.root / "big.txt"
        big.write_text(("0123456789" * 1000) + " needle-end", encoding="utf-8")
        small_settings = replace(self.files_settings, files_max_read_bytes=1024)
        with patch.object(config, "settings", small_settings):
            read = local_files.read_file("big.txt", max_chars=500)
            search = local_files.search_files("needle-end", ".", 10)
        self.assertLessEqual(len(read["content"]), 500)
        self.assertTrue(read["truncated"])
        # The search cannot silently scan an unbounded file to find text beyond its cap.
        self.assertEqual(search["results"], [])
        self.assertLessEqual(search["files_scanned"], local_files.MAX_SEARCH_FILES)

    def test_health_exposes_no_absolute_root(self):
        with patch.object(config, "settings", self.files_settings):
            health = local_files.health()
            registry_health = asyncio.run(integrations.integration_health())
        self.assertEqual(health["state"], "ready")
        self.assertEqual(health["mode"], "read_only")
        self.assertNotIn(str(self.root), str(health))
        self.assertNotIn(str(self.root), str(registry_health))

    def test_planner_requires_explicit_file_read_shapes(self):
        listing = plan_read_tool("List my files")
        search = plan_read_tool("Search my files for apricot compass")
        scoped_search = plan_read_tool("Search my files in notes for apricot compass")
        read = plan_read_tool("Read file: notes/plan.md")
        ambiguous = plan_read_tool("I was thinking about my files yesterday")

        self.assertEqual(listing.action, "files.list")
        self.assertEqual(search.action, "files.search")
        self.assertEqual(search.arguments["path"], ".")
        self.assertEqual(scoped_search.arguments["path"], "notes")
        self.assertEqual(read.action, "files.read")
        self.assertEqual(read.arguments["path"], "notes/plan.md")
        self.assertIsNone(ambiguous)

    def test_orchestrator_reads_file_locally_without_model_or_cloud(self):
        with (
            patch.object(config, "settings", self.files_settings),
            patch.object(orchestrator, "ollama_chat", new=AsyncMock(side_effect=AssertionError("local model should not run"))),
            patch.object(orchestrator, "ollama_route", new=AsyncMock(side_effect=AssertionError("router should not run"))),
            patch.object(orchestrator, "execute_cloud_request", new=AsyncMock(side_effect=AssertionError("cloud should not run"))),
        ):
            result = asyncio.run(orchestrator.orchestrate(
                channel="api",
                message="Read file: notes/plan.md",
                conversation_id="files-local-read",
            ))
        self.assertEqual(result["decision"], "tool")
        self.assertEqual(result["tool_action"], "files.read")
        self.assertEqual(result["integration"], "local_files")
        self.assertIn("apricot compass", result["reply"])
        self.assertFalse(result["memory_sent"])


if __name__ == "__main__":
    unittest.main()

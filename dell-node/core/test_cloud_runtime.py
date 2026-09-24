import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import cloud_execution, db, lifecycle, providers
from app.orchestrator import orchestrate


class CloudRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "core.sqlite3")
        self.patch_db_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.db_path))
        self.patch_db_settings.start()
        db.initialise()
        lifecycle.initialise_request_store()

    def tearDown(self):
        self.patch_db_settings.stop()
        self.temp.cleanup()

    def _openai_enabled(self):
        return patch.object(
            providers,
            "settings",
            replace(providers.settings, openai_api_key="test-key", openai_model="gpt-5.6-terra"),
        )

    def test_registry_enables_configured_cloud_provider_without_exposing_key(self):
        with self._openai_enabled():
            registry = {item["name"]: item for item in providers.provider_registry()}
        self.assertTrue(registry["openai"]["enabled"])
        self.assertEqual(registry["openai"]["model"], "gpt-5.6-terra")
        self.assertNotIn("api_key", registry["openai"])
        self.assertNotIn("test-key", str(registry["openai"]))

    def test_public_cloud_request_executes_when_provider_is_configured(self):
        result_payload = {
            "provider": "openai",
            "model": "gpt-5.6-terra",
            "reply": "Packaging standards summary.",
            "usage": {"input_tokens": 12, "output_tokens": 8},
            "web_search": True,
        }
        with self._openai_enabled(), patch.object(
            cloud_execution, "cloud_complete", new=AsyncMock(return_value=result_payload)
        ) as complete:
            result = asyncio.run(orchestrate(
                channel="api",
                message="Research current Python packaging standards",
            ))

        self.assertEqual(result["decision"], "cloud")
        self.assertEqual(result["provider"], "openai")
        self.assertEqual(result["reply"], "Packaging standards summary.")
        self.assertTrue(result["web_search"])
        self.assertFalse(result["memory_sent"])
        complete.assert_awaited_once()
        self.assertTrue(complete.await_args.kwargs["web_search"])

    def test_private_cloud_request_requires_exact_scope_approval_even_if_provider_disabled(self):
        result = asyncio.run(cloud_execution.execute_cloud_request(
            request_id="req-private",
            prompt="Research my boiler warranty online",
            provider="openai",
        ))
        self.assertEqual(result["state"], "approval_required")
        self.assertEqual(result["provider"], "openai")
        approval = result["approval"]
        self.assertEqual(approval["state"], "pending")
        self.assertTrue(approval["scope_hash"])
        self.assertNotIn("boiler warranty", approval["summary"].lower())

    def test_changed_private_prompt_cannot_inherit_confirmation(self):
        first_prompt = "Research my boiler warranty online"
        changed_prompt = "Research my mortgage account online"
        cloud_result = {
            "provider": "openai",
            "model": "gpt-5.6-terra",
            "reply": "Done.",
            "usage": {"input_tokens": 5, "output_tokens": 2},
            "web_search": True,
        }
        with self._openai_enabled(), patch.object(
            cloud_execution, "cloud_complete", new=AsyncMock(return_value=cloud_result)
        ) as complete:
            first = asyncio.run(cloud_execution.execute_cloud_request(
                request_id="req-scope",
                prompt=first_prompt,
                provider="openai",
            ))
            changed = asyncio.run(cloud_execution.execute_cloud_request(
                request_id="req-scope",
                prompt=changed_prompt,
                provider="openai",
                confirmed=True,
            ))
            approved = asyncio.run(cloud_execution.execute_cloud_request(
                request_id="req-scope",
                prompt=first_prompt,
                provider="openai",
                confirmed=True,
            ))

        self.assertEqual(first["state"], "approval_required")
        self.assertEqual(changed["state"], "approval_required")
        self.assertNotEqual(first["approval"]["id"], changed["approval"]["id"])
        self.assertEqual(approved["state"], "completed")
        complete.assert_awaited_once()

    def test_web_request_prefers_openai_and_coding_can_use_configured_claude(self):
        both = replace(
            providers.settings,
            openai_api_key="openai-key",
            anthropic_api_key="anthropic-key",
        )
        with patch.object(providers, "settings", both):
            self.assertEqual(cloud_execution.choose_provider("Search the web for Python news"), "openai")
            self.assertEqual(cloud_execution.choose_provider("Refactor this TypeScript architecture"), "claude")


if __name__ == "__main__":
    unittest.main()

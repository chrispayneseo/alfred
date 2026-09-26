import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import config, db, execution, integration_adapters, integrations

class DeveloperPlatformTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.db_patch=patch.object(db,"settings",replace(db.settings,sqlite_path=str(Path(self.temp.name)/"core.sqlite3")))
        self.execution_patch=patch.object(execution,"connection",db.connection)
        self.db_patch.start(); self.execution_patch.start(); db.initialise(); execution.initialise_execution_store()
    def tearDown(self):
        self.execution_patch.stop(); self.db_patch.stop(); self.temp.cleanup()
    def _settings(self):
        return replace(config.settings,github_token="gh-token",github_owner="chrispayneseo",
                       vercel_token="vc-token",vercel_team_id="team")

    def test_registry_exposes_account_level_development_integrations(self):
        with patch.object(config,"settings",self._settings()):
            gh=integrations.get_integration("github"); vc=integrations.get_integration("vercel")
        self.assertEqual(gh["state"],"ready"); self.assertEqual(vc["state"],"ready")
        self.assertTrue(all(c["enabled"] for c in gh["capabilities"]))
        self.assertTrue(all(c["enabled"] for c in vc["capabilities"]))

    def test_github_repository_reads_are_automatic_and_verified(self):
        payload={"ok":True,"repos":[{"name":"alfred","full_name":"chrispayneseo/alfred","private":False,
                 "archived":False,"default_branch":"main","updated_at":"2026-09-26T00:00:00Z","html_url":"https://github.com/chrispayneseo/alfred"}]}
        with patch.object(config,"settings",self._settings()), patch.object(integration_adapters,"github_list_repos",new=AsyncMock(return_value=payload)):
            result=asyncio.run(execution.execute_tool(request_id="gh-read",action="github.repos.list",arguments={"limit":100}))
        self.assertEqual(result["state"],"completed"); self.assertIsNone(result["approval"]); self.assertTrue(result["verification"]["ok"])

    def test_github_mutation_requires_exact_scope_approval(self):
        with patch.object(config,"settings",self._settings()):
            result=asyncio.run(execution.execute_tool(request_id="gh-write",action="github.branch.create",
                arguments={"full_name":"chrispayneseo/alfred","branch":"feature/test","from_ref":"main"}))
        self.assertEqual(result["state"],"approval_required"); self.assertEqual(result["approval"]["risk_level"],"reversible")

    def test_vercel_reads_are_automatic_but_redeploy_requires_approval(self):
        payload={"ok":True,"projects":[{"id":"prj_1","name":"alfred","framework":"vite","updated_at":1}]}
        with patch.object(config,"settings",self._settings()), patch.object(integration_adapters,"vercel_list_projects",new=AsyncMock(return_value=payload)):
            read=asyncio.run(execution.execute_tool(request_id="vc-read",action="vercel.projects.list",arguments={"limit":100}))
            write=asyncio.run(execution.execute_tool(request_id="vc-write",action="vercel.deployment.redeploy",arguments={"deployment_id":"dpl_1"}))
        self.assertEqual(read["state"],"completed"); self.assertTrue(read["verification"]["ok"])
        self.assertEqual(write["state"],"approval_required"); self.assertEqual(write["approval"]["risk_level"],"external")

if __name__=="__main__":
    unittest.main()

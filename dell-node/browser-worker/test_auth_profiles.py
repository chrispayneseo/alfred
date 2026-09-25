from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from app import auth_profiles


class AuthProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.previous = auth_profiles.PROFILE_ROOT
        auth_profiles.PROFILE_ROOT = Path(self.tmp.name)

    def tearDown(self):
        auth_profiles.PROFILE_ROOT = self.previous
        self.tmp.cleanup()

    def _write_profile(self, profile_id: str = "personal"):
        root = Path(self.tmp.name)
        (root / f"{profile_id}.meta.json").write_text(json.dumps({
            "label": "Personal",
            "allowed_origins": ["https://example.com"],
            "created_at": "2026-09-25T00:00:00Z",
        }), encoding="utf-8")
        (root / f"{profile_id}.state.json").write_text(json.dumps({
            "cookies": [{"name": "session", "value": "secret-cookie"}],
            "origins": [],
        }), encoding="utf-8")

    def test_profile_summary_never_returns_storage_state(self):
        self._write_profile()
        items = auth_profiles.profile_summaries()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "personal")
        rendered = repr(items).casefold()
        self.assertNotIn("secret-cookie", rendered)
        self.assertNotIn("cookies", rendered)
        self.assertNotIn("state_path", rendered)

    def test_profile_id_cannot_escape_profile_root(self):
        with self.assertRaises(HTTPException):
            auth_profiles._paths("../escape")

    def test_profile_requires_explicit_public_origin_scope(self):
        root = Path(self.tmp.name)
        (root / "personal.meta.json").write_text(json.dumps({
            "label": "Personal",
            "allowed_origins": [],
        }), encoding="utf-8")
        (root / "personal.state.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(HTTPException):
            auth_profiles._load_profile("personal")


if __name__ == "__main__":
    unittest.main()

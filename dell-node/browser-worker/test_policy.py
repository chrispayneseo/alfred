import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app import main, policy


class BrowserPolicyTests(unittest.TestCase):
    def test_private_and_non_http_urls_are_blocked(self):
        for value in (
            "http://127.0.0.1",
            "http://0.0.0.0",
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://192.168.1.1",
            "http://169.254.169.254",
            "http://[::1]",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ):
            with self.assertRaises(policy.BrowserPolicyError):
                policy.validate_public_url(value)

    def test_embedded_url_credentials_are_blocked(self):
        with self.assertRaises(policy.BrowserPolicyError):
            policy.validate_public_url("https://user:password@example.com/path")

    def test_public_dns_target_is_allowed_only_when_all_answers_are_global(self):
        public = [(2, 1, 6, "", ("93.184.216.34", 443))]
        private = [(2, 1, 6, "", ("192.168.1.10", 443))]
        mixed = public + private
        with patch("app.policy.socket.getaddrinfo", return_value=public):
            self.assertEqual(policy.validate_public_url("https://example.com/path"), "https://example.com/path")
        with patch("app.policy.socket.getaddrinfo", return_value=private):
            with self.assertRaises(policy.BrowserPolicyError):
                policy.validate_public_url("https://example.com/path")
        with patch("app.policy.socket.getaddrinfo", return_value=mixed):
            with self.assertRaises(policy.BrowserPolicyError):
                policy.validate_public_url("https://example.com/path")

    def test_safe_mode_blocks_mutating_methods(self):
        self.assertTrue(policy.method_allowed("GET", submit_mode=False, same_target_origin=False))
        self.assertFalse(policy.method_allowed("POST", submit_mode=False, same_target_origin=True))
        self.assertTrue(policy.method_allowed("POST", submit_mode=True, same_target_origin=True))
        self.assertFalse(policy.method_allowed("POST", submit_mode=True, same_target_origin=False))

    def test_sensitive_selectors_are_blocked(self):
        for selector in (
            "input[type=password]",
            "#cvv",
            "input[name=card-number]",
            "#otp_code",
            "input[type=file]#upload-token",
        ):
            with self.assertRaises(policy.BrowserPolicyError):
                policy.validate_selector(selector)
        self.assertEqual(policy.validate_selector("input[name=email]"), "input[name=email]")

    def test_state_fingerprint_changes_with_prepared_values(self):
        first = policy.state_fingerprint("https://example.com", {"#name": "Chris"})
        same = policy.state_fingerprint("https://example.com", {"#name": "Chris"})
        changed = policy.state_fingerprint("https://example.com", {"#name": "Other"})
        changed_url = policy.state_fingerprint("https://example.com/changed", {"#name": "Chris"})
        self.assertEqual(first, same)
        self.assertNotEqual(first, changed)
        self.assertNotEqual(first, changed_url)

    def test_submission_kind_is_bounded(self):
        self.assertEqual(policy.validate_submit_kind("purchase"), "purchase")
        with self.assertRaises(policy.BrowserPolicyError):
            policy.validate_submit_kind("send_money")


class BrowserSubmissionHardeningTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        main.SESSIONS.clear()

    def _session(self, *, url="https://example.com/form"):
        now = time.monotonic()
        item = main.Session(
            id="phase5i-session",
            context=None,
            page=SimpleNamespace(url=url),
            created_at=now,
            last_used=now,
        )
        item.prepared_fields = {"#name": "Chris"}
        main.SESSIONS[item.id] = item
        return item

    async def test_stale_prepared_state_is_rejected_before_dispatch(self):
        session = self._session()
        request = main.SubmitRequest(
            selector="button[type=submit]",
            state_fingerprint="0" * 64,
            target_origin="https://example.com",
            kind="form_submit",
            idempotency_key="1" * 64,
        )
        with patch.object(main, "origin_for", return_value="https://example.com"):
            with self.assertRaises(HTTPException) as caught:
                await main.submit(session.id, request)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("stale", str(caught.exception.detail).lower())
        self.assertEqual(session.unsafe_requests, [])
        self.assertEqual(session.submissions, {})

    async def test_changed_target_origin_is_rejected_before_dispatch(self):
        session = self._session()
        request = main.SubmitRequest(
            selector="button[type=submit]",
            state_fingerprint=session.fingerprint(),
            target_origin="https://example.com",
            kind="form_submit",
            idempotency_key="2" * 64,
        )

        def fake_origin(value):
            if value == "https://example.com":
                return "https://example.com"
            return "https://other.example"

        with patch.object(main, "origin_for", side_effect=fake_origin):
            with self.assertRaises(HTTPException) as caught:
                await main.submit(session.id, request)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("origin", str(caught.exception.detail).lower())
        self.assertEqual(session.unsafe_requests, [])
        self.assertEqual(session.submissions, {})

    async def test_submission_idempotency_replays_cached_result_without_dispatch(self):
        session = self._session()
        key = "3" * 64
        session.submissions[key] = {
            "ok": True,
            "dispatch_verified": True,
            "session_id": session.id,
            "idempotency_key": key,
        }
        request = main.SubmitRequest(
            selector="button[type=submit]",
            state_fingerprint="9" * 64,
            target_origin="https://example.com",
            kind="form_submit",
            idempotency_key=key,
        )
        with patch.object(main, "origin_for", return_value="https://example.com"):
            result = await main.submit(session.id, request)
        self.assertTrue(result["replayed"])
        self.assertTrue(result["dispatch_verified"])
        self.assertEqual(session.unsafe_requests, [])
        self.assertEqual(len(session.submissions), 1)


if __name__ == "__main__":
    unittest.main()

import unittest
from unittest.mock import patch

from app import policy


class BrowserPolicyTests(unittest.TestCase):
    def test_private_and_non_http_urls_are_blocked(self):
        for value in ("http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254", "file:///etc/passwd", "javascript:alert(1)"):
            with self.assertRaises(policy.BrowserPolicyError):
                policy.validate_public_url(value)

    def test_public_dns_target_is_allowed_only_when_all_answers_are_global(self):
        public = [(2, 1, 6, "", ("93.184.216.34", 443))]
        private = [(2, 1, 6, "", ("192.168.1.10", 443))]
        with patch("app.policy.socket.getaddrinfo", return_value=public):
            self.assertEqual(policy.validate_public_url("https://example.com/path"), "https://example.com/path")
        with patch("app.policy.socket.getaddrinfo", return_value=private):
            with self.assertRaises(policy.BrowserPolicyError):
                policy.validate_public_url("https://example.com/path")

    def test_safe_mode_blocks_mutating_methods(self):
        self.assertTrue(policy.method_allowed("GET", submit_mode=False, same_target_origin=False))
        self.assertFalse(policy.method_allowed("POST", submit_mode=False, same_target_origin=True))
        self.assertTrue(policy.method_allowed("POST", submit_mode=True, same_target_origin=True))
        self.assertFalse(policy.method_allowed("POST", submit_mode=True, same_target_origin=False))

    def test_sensitive_selectors_are_blocked(self):
        for selector in ("input[type=password]", "#cvv", "input[name=card-number]", "#otp_code"):
            with self.assertRaises(policy.BrowserPolicyError):
                policy.validate_selector(selector)
        self.assertEqual(policy.validate_selector("input[name=email]"), "input[name=email]")

    def test_state_fingerprint_changes_with_prepared_values(self):
        first = policy.state_fingerprint("https://example.com", {"#name": "Chris"})
        same = policy.state_fingerprint("https://example.com", {"#name": "Chris"})
        changed = policy.state_fingerprint("https://example.com", {"#name": "Other"})
        self.assertEqual(first, same)
        self.assertNotEqual(first, changed)

    def test_submission_kind_is_bounded(self):
        self.assertEqual(policy.validate_submit_kind("purchase"), "purchase")
        with self.assertRaises(policy.BrowserPolicyError):
            policy.validate_submit_kind("send_money")


if __name__ == "__main__":
    unittest.main()

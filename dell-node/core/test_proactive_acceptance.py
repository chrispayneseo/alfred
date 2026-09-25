import unittest
from unittest.mock import patch

from app import (
    proactive,
    proactive_acceptance,
    proactive_delivery,
    proactive_feedback,
    proactive_preferences,
    proactive_reasoning,
    proactive_relevance,
    proactive_schedule,
)


class ProactiveAcceptanceTests(unittest.TestCase):
    def _patch_healthy(self):
        return [
            patch.object(proactive, "status", return_value={
                "enabled": True,
                "active_items": 2,
                "last_run": {
                    "state": "completed",
                    "sources": {
                        "tasks": {"state": "ready", "count": 1},
                        "calendar": {"state": "ready", "count": 1},
                        "gmail": {"state": "ready", "count": 10},
                    },
                },
            }),
            patch.object(proactive_relevance, "relevance_status", return_value={
                "mode": "deterministic_local",
                "gmail": "deterministic_metadata_v2",
                "stores_raw_gmail_metadata": False,
                "cloud_models": False,
            }),
            patch.object(proactive_reasoning, "reasoning_status", return_value={
                "mode": "deterministic_cross_source_v1",
                "creates_urgent": False,
                "cloud_models": False,
                "mutation_targets": "existing_items_only",
            }),
            patch.object(proactive_feedback, "status", return_value={
                "mode": "explicit_local_v1",
                "window_days": 30,
                "dismissals": 0,
                "snoozes": 0,
                "learned_kinds": 0,
                "creates_urgent": False,
                "demotes_urgent": False,
                "cloud_models": False,
                "stores_connected_content": False,
            }),
            patch.object(proactive_delivery, "delivery_status", return_value={
                "enabled": True,
                "morning_brief_enabled": True,
                "configured": True,
                "channel": "ntfy_generic",
                "content_policy": "generic_only",
            }),
            patch.object(proactive_schedule, "due_status", return_value={
                "enabled": True,
                "scheduled_time": "08:00",
                "today_generated": True,
            }),
            patch.object(proactive_preferences, "current", return_value={
                "enabled": True,
                "source": "local_override",
            }),
        ]

    def _healthy_status(self):
        patches = self._patch_healthy()
        for item in patches:
            item.start()
        try:
            return proactive_acceptance.acceptance_status()
        finally:
            for item in reversed(patches):
                item.stop()

    def test_healthy_stack_is_accepted_and_ready(self):
        status = self._healthy_status()
        self.assertEqual(status["phase"], "4K")
        self.assertEqual(status["mode"], "phase4_acceptance_v1")
        self.assertEqual(status["state"], "ready")
        self.assertTrue(status["accepted"])
        self.assertTrue(all(status["checks"].values()))
        self.assertEqual(status["modes"]["relevance"], "deterministic_metadata_v2")
        self.assertEqual(status["modes"]["reasoning"], "deterministic_cross_source_v1")
        self.assertEqual(status["modes"]["feedback"], "explicit_local_v1")

    def test_connected_source_outage_is_degraded_not_failed(self):
        patches = self._patch_healthy()
        patches[0] = patch.object(proactive, "status", return_value={
            "enabled": True,
            "active_items": 2,
            "last_run": {
                "state": "degraded",
                "sources": {
                    "tasks": {"state": "ready", "count": 1},
                    "calendar": {"state": "unavailable", "error_type": "TimeoutError"},
                    "gmail": {"state": "ready", "count": 10},
                },
            },
        })
        for item in patches:
            item.start()
        try:
            status = proactive_acceptance.acceptance_status()
        finally:
            for item in reversed(patches):
                item.stop()
        self.assertEqual(status["state"], "degraded")
        self.assertTrue(status["accepted"])
        self.assertEqual(status["observation"]["degraded_sources"], ["calendar"])

    def test_failed_observation_is_not_accepted(self):
        patches = self._patch_healthy()
        patches[0] = patch.object(proactive, "status", return_value={
            "enabled": True,
            "active_items": 0,
            "last_run": {"state": "failed", "sources": {}},
        })
        for item in patches:
            item.start()
        try:
            status = proactive_acceptance.acceptance_status()
        finally:
            for item in reversed(patches):
                item.stop()
        self.assertEqual(status["state"], "failed")
        self.assertFalse(status["accepted"])

    def test_acceptance_surface_contains_no_connected_content_or_topic(self):
        status = self._healthy_status()
        forbidden = {"title", "summary", "subject", "sender", "snippet", "body", "source_ref", "topic"}

        def walk(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    self.assertNotIn(str(key).casefold(), forbidden)
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        walk(status)
        self.assertFalse(status["privacy"]["connected_content_in_status"])
        self.assertFalse(status["privacy"]["ntfy_topic_exposed"])

    def test_acceptance_route_uses_existing_authenticated_proactive_router(self):
        paths = {route.path for route in proactive.router.routes}
        self.assertIn("/v1/core/proactive/acceptance", paths)


if __name__ == "__main__":
    unittest.main()

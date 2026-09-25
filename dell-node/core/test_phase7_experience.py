from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app import experience


class Phase7ExperienceTests(unittest.TestCase):
    def test_agent_inbox_is_content_minimised_and_normalised(self):
        daily = {
            "needs_you": [
                {
                    "type": "intake",
                    "reason": "review_required",
                    "id": "wa-1",
                    "title": "Book dentist",
                    "due": "2026-10-02",
                },
                {
                    "type": "agent_approval",
                    "reason": "approval_required",
                    "id": "approval-1",
                    "action": "calendar.create",
                    "risk_level": "reversible",
                },
            ],
            "agent": {
                "active_goals": [
                    {
                        "goal_id": "goal-1",
                        "state": "running",
                        "current_step": {
                            "action": "gmail.search",
                            "state": "running",
                            "why": "Executing through the guarded Core.",
                        },
                    }
                ],
                "completed_work": [
                    {
                        "execution_id": "exec-1",
                        "action": "tasks.create",
                        "created_at": "2026-09-25 20:00:00",
                        "result": {"secret": "must not leak"},
                    }
                ],
            },
            "raw_forwarded_body": "malicious instructions",
        }
        with patch.object(experience.daily_operations, "today_view", return_value=daily):
            inbox = experience.agent_inbox()

        self.assertEqual(inbox["mode"], "agent_inbox_v1")
        self.assertEqual(inbox["counts"], {"needs_you": 2, "working": 1, "done": 1})
        self.assertFalse(inbox["raw_forwarded_body_exposed"])
        self.assertFalse(inbox["tool_results_exposed"])
        rendered = repr(inbox)
        self.assertNotIn("malicious instructions", rendered)
        self.assertNotIn("must not leak", rendered)
        self.assertEqual(inbox["needs_you"][0]["route"], "/capture")
        self.assertEqual(inbox["needs_you"][1]["route"], "/inbox")

    def test_personal_search_returns_bounded_local_results(self):
        pack = {
            "items": [
                {
                    "id": "memory:4",
                    "kind": "memory",
                    "memory_type": "decision",
                    "title": "Use the primary GitHub account",
                    "content": "Use the primary GitHub account for Alfred projects.\n" + ("x" * 500),
                    "due": None,
                    "url": "/settings?memory=4",
                    "source": "api",
                    "score": 0.93,
                }
            ],
            "budget": {"selected": 1, "used_chars": 600},
        }
        with patch.object(experience.memory_service, "build_context_pack", return_value=pack) as search:
            result = experience.personal_search("github", 12)

        search.assert_called_once_with("github", limit=12, max_chars=9000)
        self.assertEqual(result["mode"], "personal_search_local_first_v1")
        self.assertFalse(result["cloud_models"])
        self.assertEqual(result["count"], 1)
        self.assertLessEqual(len(result["results"][0]["snippet"]), 320)

    def test_notifications_are_event_driven_not_a_daily_briefing(self):
        inbox = {
            "needs_you": [
                {"type": "agent_approval", "id": "a1", "title": "calendar.create", "reason": "approval_required", "route": "/inbox"}
            ],
            "done": [
                {"id": "e1", "title": "tasks.create", "reason": "Verified completed", "route": "/inbox"}
            ],
        }
        with patch.object(experience, "agent_inbox", return_value=inbox):
            result = experience.notifications()
        self.assertEqual(result["delivery"], "in_app_event_feed")
        self.assertFalse(result["daily_briefing"])
        self.assertFalse(result["unsolicited_cloud_reasoning"])
        self.assertEqual(result["count"], 2)


class Phase7CommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_command_delegates_to_authoritative_orchestrator(self):
        fake = {
            "request_id": "req-1",
            "conversation_id": "conv-1",
            "decision": "local",
            "reply": "Done",
        }
        with patch.object(experience, "orchestrate", new=AsyncMock(return_value=fake)) as orchestrate:
            result = await experience.experience_command(
                experience.CommandRequest(
                    message="What do I need to do today?",
                    conversation_id="conv-1",
                    history=[{"role": "user", "content": "Earlier"}],
                )
            )
        orchestrate.assert_awaited_once()
        kwargs = orchestrate.await_args.kwargs
        self.assertEqual(kwargs["channel"], "web")
        self.assertEqual(kwargs["message"], "What do I need to do today?")
        self.assertEqual(kwargs["conversation_id"], "conv-1")
        self.assertTrue(callable(kwargs["recall_answerer"]))
        self.assertTrue(result["experience"]["authoritative_core"])


if __name__ == "__main__":
    unittest.main()

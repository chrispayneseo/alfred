from __future__ import annotations

import unittest
from unittest.mock import patch

from app import phase10_acceptance, proactive_intelligence


class Phase10IntelligenceTests(unittest.TestCase):
    def test_signals_are_selective_explainable_and_non_mutating(self):
        daily = {
            "date": "2026-09-25",
            "open_local_items": [
                {"source_id": "task-1", "title": "Renew insurance", "due": "2026-09-23"},
                {"source_id": "task-2", "title": "Send forms", "due": "2026-09-25"},
                {"source_id": "task-3", "title": "No deadline", "due": None},
            ],
            "needs_you": [
                {"type": "agent_approval", "id": "approval-1", "action": "calendar.events.create"},
                {"type": "agent_attention", "id": "exec-1", "action": "browser.submit", "state": "reconciliation_required", "why": "Outcome is ambiguous."},
                {"type": "intake", "id": "capture-1", "title": "Book appointment", "reason": "review_required"},
            ],
        }
        with patch.object(proactive_intelligence.daily_operations, "today_view", return_value=daily), patch.object(
            proactive_intelligence.knowledge, "contradictions",
            return_value=[{"candidate_id": "conflict-1"}],
        ), patch.object(
            proactive_intelligence.knowledge, "status",
            return_value={"stale_review_candidates": 2},
        ):
            result = proactive_intelligence.signals()
        kinds = {item["kind"] for item in result["items"]}
        self.assertTrue({"overdue_commitment", "due_today", "waiting_approval", "execution_attention", "captured_item_review", "knowledge_conflict", "stale_knowledge"}.issubset(kinds))
        overdue = next(item for item in result["items"] if item["kind"] == "overdue_commitment")
        self.assertTrue(overdue["interruption"])
        attention = next(item for item in result["items"] if item["kind"] == "execution_attention")
        self.assertTrue(attention["interruption"])
        self.assertFalse(result["daily_briefing"])
        self.assertFalse(result["unsolicited_cloud_reasoning"])
        self.assertFalse(result["automatic_external_action"])

    def test_low_value_undated_item_does_not_create_signal(self):
        daily = {
            "date": "2026-09-25",
            "open_local_items": [{"source_id": "task-1", "title": "Maybe someday", "due": None}],
            "needs_you": [],
        }
        with patch.object(proactive_intelligence.daily_operations, "today_view", return_value=daily), patch.object(
            proactive_intelligence.knowledge, "contradictions", return_value=[]
        ), patch.object(
            proactive_intelligence.knowledge, "status", return_value={"stale_review_candidates": 0}
        ):
            result = proactive_intelligence.signals()
        self.assertEqual(result["items"], [])


class Phase10AcceptanceTests(unittest.TestCase):
    def test_contract_and_previous_phase_gate(self):
        with patch.object(
            phase10_acceptance.phase9_acceptance, "acceptance_status",
            return_value={"accepted": True, "mode": "phase9_deep_memory_acceptance_v1"},
        ):
            accepted = phase10_acceptance.acceptance_status()
        self.assertTrue(accepted["accepted"], accepted["failed_checks"])
        self.assertEqual(accepted["check_count"], 10)
        self.assertFalse(accepted["new_executor"])
        self.assertFalse(accepted["automatic_external_action"])

        with patch.object(
            phase10_acceptance.phase9_acceptance, "acceptance_status",
            return_value={"accepted": False, "mode": "phase9_deep_memory_acceptance_v1"},
        ):
            failed = phase10_acceptance.acceptance_status()
        self.assertFalse(failed["accepted"])
        self.assertIn("phase9_baseline_preserved", failed["failed_checks"])


if __name__ == "__main__":
    unittest.main()

import asyncio
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import db, inbox_api, main, recall_store
from app.core import decide, normalise_request


class RecallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.core_path = str(base / "core.sqlite3")
        self.patch_settings = patch.object(db, "settings", replace(db.settings, sqlite_path=self.core_path))
        self.patch_inbox_path = patch.object(inbox_api, "INBOX_DB", str(base / "inbox.sqlite3"))
        self.patch_settings.start()
        self.patch_inbox_path.start()
        db.initialise()
        inbox_api.initialise()

    def tearDown(self):
        self.patch_inbox_path.stop()
        self.patch_settings.stop()
        self.temp.cleanup()

    def test_memory_search_correction_and_forget_update_index(self):
        memory_id = db.remember("note", "The spare key is in the blue drawer", "test")
        self.assertEqual(recall_store.search("Where is the spare key?")[0]["id"], f"memory:{memory_id}")
        self.assertTrue(db.correct_memory(memory_id, "The spare key is in the green drawer"))
        self.assertEqual(recall_store.search("blue drawer"), [])
        self.assertEqual(recall_store.search("green drawer")[0]["id"], f"memory:{memory_id}")
        self.assertTrue(db.forget(memory_id))
        self.assertEqual(recall_store.search("green drawer"), [])

    def test_preexisting_memories_are_backfilled(self):
        with sqlite3.connect(self.core_path) as connection:
            connection.execute("DROP TRIGGER memories_fts_ai")
            connection.execute("DROP TRIGGER memories_fts_ad")
            connection.execute("DROP TRIGGER memories_fts_au")
            connection.execute("DROP TABLE memories_fts")
            connection.execute("INSERT INTO memories(kind, content, source) VALUES ('note', 'Loft insulation estimate', 'test')")
        db.initialise()
        self.assertEqual(len(recall_store.search("loft insulation")), 1)

    def test_approved_tasks_and_reminders_are_searchable(self):
        task = inbox_api.ManualFiling(source_id="manual:bb778937-58b9-4c63-b22a-123451234512",
            kind="task", title="Check loft insulation", detail="Get a quote")
        reminder = inbox_api.ManualFiling(source_id="manual:db778937-58b9-4c63-b22a-123451234512",
            kind="reminder", title="Renew car insurance", due="2099-09-26")
        asyncio.run(inbox_api.create_filed(task))
        asyncio.run(inbox_api.create_filed(reminder))
        self.assertEqual(recall_store.search("loft insulation")[0]["kind"], "task")
        self.assertEqual(recall_store.search("What reminders are coming up?")[0]["title"], "Renew car insurance")
        edit = inbox_api.ItemCorrection(title="Check attic insulation", detail="Get a quote")
        asyncio.run(inbox_api.correct_filed(task.source_id, edit))
        self.assertEqual(recall_store.search("loft"), [])
        self.assertEqual(recall_store.search("attic")[0]["kind"], "task")
        asyncio.run(inbox_api.forget_filed(task.source_id))
        self.assertEqual(recall_store.search("attic"), [])

    def test_inbox_note_is_one_search_result_and_forget_removes_both_copies(self):
        note = inbox_api.ManualFiling(source_id="manual:bb778937-58b9-4c63-b22a-123451234512",
            kind="note", title="Loft estimate", detail="Ask Sam")
        asyncio.run(inbox_api.create_filed(note))
        found = recall_store.search("loft estimate")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["kind"], "memory")
        memory_id = int(found[0]["id"].split(":")[1])
        db.correct_memory(memory_id, "Attic estimate\nAsk Sam")
        self.assertEqual(recall_store.search("loft"), [])
        db.forget(memory_id)
        self.assertEqual(recall_store.search("attic"), [])
        self.assertEqual(asyncio.run(inbox_api.get_filed())["items"], [])

    def test_fts_query_is_safe_and_no_match_is_honest(self):
        self.assertEqual(recall_store.search('" OR * --'), [])
        response = asyncio.run(main.gateway(main.GatewayRequest(message="What did I save about unicorns?")))
        self.assertEqual(response["decision"], "local")
        self.assertIn("couldn't find", response["reply"])
        self.assertEqual(response["sources"], [])

    def test_natural_save_question_finds_saved_note(self):
        memory_id = db.remember("note", "Copper kettle is in the greenhouse", "test")
        found = recall_store.search("What did I save about copper kettle?")
        self.assertEqual(found[0]["id"], f"memory:{memory_id}")

    def test_model_failure_shows_exact_saved_text_not_an_invented_answer(self):
        source = {"kind": "memory", "title": "Spare key", "content": "Spare key is in the kitchen drawer", "due": None, "completed": False}
        with patch.object(main, "ollama_recall", new=AsyncMock(side_effect=RuntimeError("model unavailable"))):
            reply = asyncio.run(main.answer_from_recall("Where is the spare key?", [source]))
        self.assertIn("Spare key is in the kitchen drawer", reply)

    def test_local_recall_never_calls_cloud_route(self):
        db.remember("note", "The spare key is in the blue drawer", "test")
        with patch.object(main, "ollama_recall", new=AsyncMock(return_value="It is in the blue drawer.")), \
             patch.object(main, "ollama_route", new=AsyncMock(side_effect=AssertionError("cloud route called"))):
            response = asyncio.run(main.gateway(main.GatewayRequest(message="Where is the spare key?")))
        self.assertEqual(response["decision"], "local")
        self.assertEqual(response["sources"][0]["url"].startswith("/settings?memory="), True)

    def test_saved_item_with_current_word_stays_local_but_explicit_research_asks_approval(self):
        db.remember("note", "Latest boiler warranty is in the kitchen drawer", "test")
        with patch.object(main, "ollama_recall", new=AsyncMock(return_value="It is in the kitchen drawer.")), \
             patch.object(main, "ollama_route", new=AsyncMock(side_effect=AssertionError("cloud route called"))):
            answer = asyncio.run(main.gateway(main.GatewayRequest(message="What did I save about latest boiler warranty?")))
        self.assertEqual(answer["decision"], "local")
        approval = asyncio.run(main.gateway(main.GatewayRequest(message="Research my boiler warranty online")))
        self.assertEqual(approval["decision"], "approval_required")
        self.assertFalse(approval["memory_sent"])
        self.assertEqual(approval["cloud_prompt"], "Research my boiler warranty online")

    def test_core_policy_requires_confirmation_for_writes_and_device_actions(self):
        self.assertEqual(decide("memory.write").decision, "confirm")
        self.assertEqual(decide("memory.write", confirmed=True).decision, "auto")
        self.assertEqual(decide("home_assistant.service").decision, "confirm")
        self.assertEqual(decide("unregistered").decision, "deny")

    def test_canonical_request_does_not_trust_a_channel_to_set_identity(self):
        item = normalise_request("web", "What is on tomorrow?", "calendar-check")
        self.assertEqual(item["user"], "Chris")
        self.assertEqual(item["trust_level"], "owner")
        self.assertEqual(item["conversation_id"], "calendar-check")

    def test_tool_registry_and_event_policy_fail_closed(self):
        from app.core import event_decision, tool_registry
        self.assertIn("memory.write", {tool["name"] for tool in tool_registry()})
        self.assertEqual(event_decision("calendar.changed"), "store")
        self.assertEqual(event_decision("unknown.untrusted"), "ignore")

    def test_plan_approval_and_event_ledger_are_durable(self):
        plan = db.create_plan("request-1", "Prepare tomorrow", [{"action": "calendar.read"}])
        self.assertEqual(db.list_plans()[0]["id"], plan["id"])
        approval = db.create_approval("request-1", plan["id"], "home_assistant.service", "Turn on lamp", "reversible")
        self.assertTrue(db.resolve_approval(approval["id"], True))
        self.assertFalse(db.resolve_approval(approval["id"], True))
        self.assertEqual(db.record_event("timer.due", "test", "store", {"name": "briefing"})["decision"], "store")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env bash
set -euo pipefail
cd /opt/alfred-node

echo "=== PHASE 9 DEEP MEMORY CONTRACT ==="
sudo docker compose exec -T core python - <<'PY'
from app import knowledge, phase9_acceptance, proactive
from app.db import connection


def execution_counts():
    with connection() as db:
        return {
            table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("core_executions", "approvals", "agent_goals")
        }

before = execution_counts()
status = phase9_acceptance.acceptance_status()
knowledge_status = knowledge.status()
entities = knowledge.entity_index(20)
after = execution_counts()
paths = {route.path for route in proactive.router.routes}

assert status["mode"] == "phase9_deep_memory_acceptance_v1"
assert status["accepted"] is True, status["failed_checks"]
assert status["check_count"] == 10
assert status["new_executor"] is False
assert status["cloud_models"] is False
assert status["mutations"] is False
assert knowledge_status["connected_payload_indexed"] is False
assert knowledge_status["transient_conversation_indexed"] is False
assert knowledge_status["model_auto_memory"] is False
assert knowledge_status["contradictions_require_owner_review"] is True
assert before == after, (before, after)
for path in (
    "/v1/core/knowledge/status", "/v1/core/knowledge/search",
    "/v1/core/knowledge/entities", "/v1/core/knowledge/entities/{entity}",
    "/v1/core/knowledge/history", "/v1/core/knowledge/contradictions",
    "/v1/core/phase9/status",
):
    assert path in paths, path
print("PASS: Phase 9 preserves provenance, confidence and supersession")
print("PASS: contradictions remain owner-review items rather than silent replacements")
print("PASS: connected payloads and transient chat are not shadow-indexed")
print("PASS: Phase 9 adds no executor or cloud dependency")
print("PASS: knowledge status/search metadata creates no execution or approval state")
print(f"  active memories: {knowledge_status['active_memory_count']}")
print(f"  indexed entities: {knowledge_status['entity_count']}")
print(f"  unresolved conflicts: {knowledge_status['open_conflicts']}")
print(f"  sample entity count: {len(entities)}")
PY

echo
echo "=== PHASE 9 ADVERSARIAL ACCEPTANCE ==="
sudo docker compose run --rm --no-deps \
  -v /opt/alfred-node/core/test_phase9_knowledge.py:/app/test_phase9_knowledge.py:ro \
  core python -m unittest test_phase9_knowledge -v

echo
echo "Phase 9 acceptance completed without external mutation or cloud reasoning."

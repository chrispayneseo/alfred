#!/usr/bin/env bash
set -euo pipefail
cd /opt/alfred-node

echo "=== PHASE 12 AUTONOMOUS PROJECTS CONTRACT ==="
sudo docker compose exec -T core python - <<'PY'
from app import phase12_acceptance, projects, proactive
from app.db import connection

projects.initialise()

def counts():
    with connection() as db:
        return {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("core_executions", "approvals", "agent_goals", "agent_projects")}

before = counts()
status = phase12_acceptance.acceptance_status()
project_status = projects.status()
items = projects.list_projects(10)
after = counts()
paths = {route.path for route in proactive.router.routes}

assert status["mode"] == "phase12_autonomous_projects_acceptance_v1"
assert status["accepted"] is True, status["failed_checks"]
assert status["check_count"] == 10
assert status["new_executor"] is False
assert status["automatic_approval"] is False
assert status["automatic_mutation_replay"] is False
assert project_status["max_milestones"] == 8
assert project_status["milestones_per_run"] == 1
assert project_status["bounded_agent_loop_reused"] is True
assert project_status["verification_recovery_reused"] is True
assert before == after, (before, after)

for path in (
    "/v1/core/projects/status",
    "/v1/core/projects",
    "/v1/core/projects/{project_id}",
    "/v1/core/projects/{project_id}/run",
    "/v1/core/projects/{project_id}/cancel",
    "/v1/core/phase12/status",
):
    assert path in paths, path

print("PASS: Phase 12 projects are durable bounded coordinators")
print("PASS: each project invocation may create at most one new milestone goal")
print("PASS: milestones reuse registered operations, durable goals and the existing bounded agent loop")
print("PASS: exact-scope approvals, verification and reconciliation remain authoritative")
print("PASS: projects cannot auto-approve or replay ambiguous mutations")
print("PASS: reading project surfaces creates no execution or approval state")
print(f"  projects now: {len(items)}")
PY

echo
echo "=== PHASE 12 ADVERSARIAL ACCEPTANCE ==="
sudo docker compose run --rm --no-deps \
  -v /opt/alfred-node/core/test_phase12_projects.py:/app/test_phase12_projects.py:ro \
  core python -m unittest test_phase12_projects -v

echo
echo "Phase 12 acceptance completed without creating or running a live project."

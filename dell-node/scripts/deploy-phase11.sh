#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
NODE_ROOT="/opt/alfred-node"
RELEASE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

echo "=== PHASE 11 SEQUENTIAL DEPLOY ==="
echo "Release SHA: $RELEASE_SHA"
test -x "$NODE_ROOT/scripts/phase10-proactive-intelligence-smoke.sh"
sudo bash "$NODE_ROOT/scripts/phase10-proactive-intelligence-smoke.sh"
STAMP="$(date +%Y%m%d-%H%M%S)"
sudo cp -a "$NODE_ROOT/core" "$NODE_ROOT/core.pre-phase11-$STAMP"
sudo rsync -a --delete "$REPO_ROOT/dell-node/core/" "$NODE_ROOT/core/"
sudo install -m 0755 "$REPO_ROOT/dell-node/scripts/phase11-life-work-operations-smoke.sh" "$NODE_ROOT/scripts/phase11-life-work-operations-smoke.sh"
cd "$NODE_ROOT"
sudo docker compose build --no-cache core
sudo docker compose up -d --force-recreate core
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/health >/tmp/alfred-phase11-health.json 2>/dev/null; then break; fi
  sleep 2
done
cat /tmp/alfred-phase11-health.json | python3 -m json.tool
sudo bash "$NODE_ROOT/scripts/phase11-life-work-operations-smoke.sh"
echo "$RELEASE_SHA" | sudo tee "$NODE_ROOT/.phase11-live-accepted" >/dev/null
sudo chmod 0644 "$NODE_ROOT/.phase11-live-accepted"
echo
echo "PHASE 11 — COMPLETE / LIVE ACCEPTED"
echo "Accepted SHA: $RELEASE_SHA"

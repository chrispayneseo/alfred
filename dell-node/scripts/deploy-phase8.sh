#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
NODE_ROOT="/opt/alfred-node"
RELEASE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

echo "=== PHASE 8 SEQUENTIAL DEPLOY ==="
echo "Release SHA: $RELEASE_SHA"

echo
echo "=== VERIFY CURRENT PHASE 7 LIVE BASELINE ==="
test -x "$NODE_ROOT/scripts/phase7-personal-agent-smoke.sh"
sudo bash "$NODE_ROOT/scripts/phase7-personal-agent-smoke.sh"

echo
echo "=== BACKUP CURRENT RUNTIME CODE ==="
STAMP="$(date +%Y%m%d-%H%M%S)"
sudo cp -a "$NODE_ROOT/core" "$NODE_ROOT/core.pre-phase8-$STAMP"
sudo cp -a "$NODE_ROOT/browser-worker" "$NODE_ROOT/browser-worker.pre-phase8-$STAMP"
sudo cp -a "$NODE_ROOT/compose.yml" "$NODE_ROOT/compose.pre-phase8-$STAMP.yml"

echo
echo "=== INSTALL PHASE 8 CODE ==="
sudo rsync -a --delete "$REPO_ROOT/dell-node/core/" "$NODE_ROOT/core/"
sudo rsync -a --delete "$REPO_ROOT/dell-node/browser-worker/" "$NODE_ROOT/browser-worker/"
sudo install -m 0644 "$REPO_ROOT/dell-node/compose.yml" "$NODE_ROOT/compose.yml"
sudo install -m 0755 "$REPO_ROOT/dell-node/scripts/phase8-secure-authenticated-web-smoke.sh" "$NODE_ROOT/scripts/phase8-secure-authenticated-web-smoke.sh"
sudo install -m 0755 "$REPO_ROOT/dell-node/scripts/phase8-browser-profile-bootstrap.py" "$NODE_ROOT/scripts/phase8-browser-profile-bootstrap.py"
sudo install -d -m 0700 -o 1000 -g 1000 "$NODE_ROOT/browser-profiles"

echo
echo "=== REBUILD PHASE 8 SERVICES ==="
cd "$NODE_ROOT"
sudo docker compose build --no-cache core browser-worker
sudo docker compose --profile browser up -d --force-recreate core browser-worker

echo
echo "=== WAIT FOR CORE ==="
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/health >/tmp/alfred-phase8-health.json 2>/dev/null; then
    break
  fi
  sleep 2
done
cat /tmp/alfred-phase8-health.json | python3 -m json.tool

echo
echo "=== PHASE 8 LIVE ACCEPTANCE ==="
sudo bash "$NODE_ROOT/scripts/phase8-secure-authenticated-web-smoke.sh"

echo "$RELEASE_SHA" | sudo tee "$NODE_ROOT/.phase8-live-accepted" >/dev/null
sudo chmod 0644 "$NODE_ROOT/.phase8-live-accepted"

echo
echo "PHASE 8 — COMPLETE / LIVE ACCEPTED"
echo "Accepted SHA: $RELEASE_SHA"
echo "ALFRED_BROWSER_SUBMIT_ENABLED must remain false unless a separately reviewed release changes that boundary."

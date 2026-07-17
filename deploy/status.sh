#!/usr/bin/env bash
# Quick health + sanity check for the deployed API.
# Run on the VPS: bash ~/hoteldesk/deploy/status.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONTAINER_NAME="hoteldesk-api"
HEALTH_URL="http://127.0.0.1:${HOTELDESK_HOST_PORT:-3010}/health"

cd "$REPO_DIR"
echo "Repo: $REPO_DIR"
echo "Repo commit:        $(git rev-parse --short HEAD)   ($(git log -1 --format=%s | head -c 60))"
echo "Container running:  $(docker inspect -f '{{.State.Status}}' $CONTAINER_NAME 2>/dev/null || echo 'NOT RUNNING')"
echo "Container started:  $(docker inspect -f '{{.State.StartedAt}}' $CONTAINER_NAME 2>/dev/null || echo '-')"
echo "Health endpoint:    $(curl -sf $HEALTH_URL || echo 'UNREACHABLE')"

# Verify deployed code lines up with this commit's source for one well-known
# string. If they diverge, the container is stale and you should redeploy.
echo ""
echo "Validator check (dirty room allowed transitions):"
docker exec "$CONTAINER_NAME" sh -c \
  "grep -A 4 'validTransitions' /app/apps/api/dist/routes/housekeeping.js | head -6" 2>/dev/null \
  || echo "  (could not read deployed code)"

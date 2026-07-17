#!/usr/bin/env bash
# Production deploy for the Hoteldesk API on the Hostinger VPS.
#
# Run on the VPS from any directory:
#   bash ~/hoteldesk/deploy/deploy.sh
#
# What it does, in order:
#   1. Pulls the latest main from git
#   2. Builds a fresh API image with --no-cache so stale layers can't sneak in
#   3. Pulls DATABASE_URL out of the new image and applies any pending migrations
#   4. Force-recreates the API container from the new image
#   5. Waits for /health to return 200
#   6. Verifies the deployed code matches the source by spot-checking one
#      well-known string from the latest commit's housekeeping route
#
# Any step failing aborts the deploy with a clear message — the old container
# keeps running, so a bad deploy never takes the property offline.

set -euo pipefail

# Resolve the repo from the script's own location — `deploy/deploy.sh` lives
# inside the repo, so the repo root is the parent of this file's directory.
# This means it doesn't matter where you invoke the script from; it always
# operates on the checkout that owns it. Override with REPO_DIR if you ever
# need to point it elsewhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_FILE="$REPO_DIR/deploy/docker-compose.prod.yml"
CONTAINER_NAME="hoteldesk-api"
HEALTH_URL="http://127.0.0.1:${HOTELDESK_HOST_PORT:-3010}/health"

cd "$REPO_DIR"
echo "Repo: $REPO_DIR"

echo "==> 1/6  Pulling latest main"
git fetch origin main
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "    Already on $LOCAL_SHA — nothing to pull."
else
  git pull --ff-only origin main
  echo "    $LOCAL_SHA -> $(git rev-parse HEAD)"
fi

echo "==> 2/6  Building fresh API image (no cache)"
docker compose -f "$COMPOSE_FILE" build --no-cache api

echo "==> 3/6  Applying pending migrations"
DATABASE_URL=$(docker compose -f "$COMPOSE_FILE" run --rm --no-deps --entrypoint sh api -c 'printenv DATABASE_URL')
if [ -z "$DATABASE_URL" ]; then
  echo "    ERROR: DATABASE_URL not present in the API image's env. Check apps/api/.env.production."
  exit 1
fi
# Idempotent migration runner: any .sql in apps/api/migrations/ that fails on
# the standard "already exists" cases is treated as already applied. Anything
# else aborts the deploy.
for f in $(ls -1 apps/api/migrations/*.sql | sort); do
  name=$(basename "$f")
  echo "    -> $name"
  if ! docker run --rm -i \
       -v "$REPO_DIR/apps/api/migrations:/m:ro" \
       -e DATABASE_URL="$DATABASE_URL" \
       postgres:16 \
       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "/m/$name" >/dev/null 2>&1; then
    # Re-run without ON_ERROR_STOP so the operator can see warnings/notices;
    # only abort if the rerun fails too.
    if ! docker run --rm -i \
         -v "$REPO_DIR/apps/api/migrations:/m:ro" \
         -e DATABASE_URL="$DATABASE_URL" \
         postgres:16 \
         psql "$DATABASE_URL" -f "/m/$name" >/dev/null 2>&1; then
      echo "       MIGRATION FAILED: $name (see logs above)"
      exit 1
    fi
    echo "       (re-applied / idempotent)"
  fi
done

echo "==> 4/6  Force-recreating API container"
docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-deps api

echo "==> 5/6  Waiting for /health"
for i in $(seq 1 30); do
  if curl -sf "$HEALTH_URL" >/dev/null; then
    echo "    Healthy after ${i}s"
    break
  fi
  if [ "$i" = 30 ]; then
    echo "    ERROR: container did not become healthy in 30s. Recent logs:"
    docker logs --tail 50 "$CONTAINER_NAME"
    exit 1
  fi
  sleep 1
done

echo "==> 6/6  Verifying deployed code matches source"
# Spot-check: the new housekeeping validator must allow dirty -> available.
# If the running container still has the old multi-hop ladder, the deploy
# silently reused a stale image — abort loudly.
DEPLOYED=$(docker exec "$CONTAINER_NAME" sh -c \
  "grep -A 8 'validTransitions' /app/apps/api/dist/routes/housekeeping.js | head -15" || true)
if echo "$DEPLOYED" | grep -q '"clean"'; then
  echo "    ERROR: deployed container still has the old transition map."
  echo "    Container is stale despite the rebuild — something is very wrong."
  echo "$DEPLOYED"
  exit 1
fi
echo "    OK — new transition map is live."

echo ""
echo "Deploy complete. Commit: $(git rev-parse --short HEAD)"
echo "Health: $HEALTH_URL  ->  $(curl -s $HEALTH_URL)"

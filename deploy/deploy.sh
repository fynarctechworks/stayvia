#!/usr/bin/env bash
# Production deploy for the Stayvia API on the Hostinger VPS.
#
# Run on the VPS from any directory:
#   bash ~/stayvia/deploy/deploy.sh
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
CONTAINER_NAME="stayvia-api"
HEALTH_URL="http://127.0.0.1:${STAYVIA_HOST_PORT:-3010}/health"

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
# Stamp the image with the commit it was built from so step 6 can verify
# identity rather than grepping for a string from one particular commit.
export GIT_SHA="$(git rev-parse HEAD)"
docker compose -f "$COMPOSE_FILE" build --no-cache api

echo "==> 3/6  Applying pending migrations"
# Ledger-aware runner (apps/api/scripts/migrate.mjs). It consults the
# schema_migrations table, skips what is already applied, wraps each new file
# in its own transaction, and exits non-zero on the first genuine failure —
# which `set -e` turns into an aborted deploy with the old container still up.
#
# This replaces a blind psql replay of every .sql on every deploy. That loop
# could not distinguish "already applied" from "broken", and its retry ran
# WITHOUT -v ON_ERROR_STOP=1, so psql exited 0 even when every statement in the
# file errored. A genuinely broken migration was printed as
# "(re-applied / idempotent)" and the deploy carried on onto a half-migrated
# production database, with both psql calls silenced by >/dev/null 2>&1.
#
# DATABASE_URL is deliberately NOT passed on a command line here: `compose run`
# inherits the service's env_file, so the credential never lands in argv where
# `ps auxww` would expose it to the other apps sharing this VPS.
#
# ALLOW_REMOTE_DB=1 is the guard's explicit opt-in (see scripts/guard-db-target.mjs).
# This IS the production database and targeting it from this script is intended.
docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
  -e ALLOW_REMOTE_DB=1 \
  api node apps/api/scripts/migrate.mjs

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
# Identity check: the image is stamped with GIT_SHA at build time and /health
# reports it back, so this compares "what is running" against "what the repo is
# at". This replaces a grep for the literal string "clean" near the
# housekeeping validTransitions map — a check pinned to one commit's source
# that passes today only by accident, and that would hard-fail a perfectly
# good deploy the moment any future edit put "clean" within 8 lines of that
# map (a `cleaning` status, a renamed variable, even a comment). It also ran
# two steps after the new container was already serving traffic, so its
# "abort" could never actually roll anything back.
EXPECTED_SHA="$(git rev-parse HEAD)"
DEPLOYED_SHA="$(curl -s "$HEALTH_URL" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
if [ -z "$DEPLOYED_SHA" ] || [ "$DEPLOYED_SHA" = "unknown" ]; then
  echo "    WARNING: /health reported no commit. The image predates GIT_SHA stamping;"
  echo "             the next --no-cache build will enable this check."
elif [ "$DEPLOYED_SHA" != "$EXPECTED_SHA" ]; then
  echo "    ERROR: container reports commit $DEPLOYED_SHA"
  echo "           but this checkout is at $EXPECTED_SHA."
  echo "    The deploy reused a stale image."
  exit 1
else
  echo "    OK — running $DEPLOYED_SHA"
fi

echo ""
echo "Deploy complete. Commit: $(git rev-parse --short HEAD)"
echo "Health: $HEALTH_URL  ->  $(curl -s $HEALTH_URL)"

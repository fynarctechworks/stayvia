# Shortcuts for the Docker dev stack. Works on macOS/Linux/WSL/Git Bash.
# Windows users without `make` can use ./hoteldesk.ps1 instead.

COMPOSE := docker compose

.PHONY: help build up down restart logs ps api-shell web-shell psql redis-cli migrate seed test clean nuke

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

build:  ## Build all images (no cache)
	$(COMPOSE) build

up:  ## Start the stack in the background
	$(COMPOSE) up -d

down:  ## Stop the stack (keeps volumes)
	$(COMPOSE) down

restart:  ## Restart api + web
	$(COMPOSE) restart api web

logs:  ## Tail logs from all services
	$(COMPOSE) logs -f --tail=200

ps:  ## Show running containers
	$(COMPOSE) ps

api-shell:  ## Open a shell inside the api container
	$(COMPOSE) exec api sh

web-shell:  ## Open a shell inside the web container
	$(COMPOSE) exec web sh

psql:  ## Open psql against the dev Postgres
	$(COMPOSE) exec postgres psql -U hoteldesk -d hoteldesk

redis-cli:  ## Open redis-cli against the dev Redis
	$(COMPOSE) exec redis redis-cli

migrate:  ## Run the API migrations against the running Postgres
	$(COMPOSE) exec api node apps/api/scripts/migrate.mjs

seed:  ## Seed dev data (uses apps/api/src/db/seed.ts)
	$(COMPOSE) exec api npx tsx apps/api/src/db/seed.ts

test:  ## Run API tests inside the container
	$(COMPOSE) exec api npm test --workspace=@hoteldesk/api

clean:  ## Stop and remove containers but keep volumes
	$(COMPOSE) down --remove-orphans

nuke:  ## Stop, remove everything INCLUDING volumes (wipes dev DB)
	$(COMPOSE) down -v --remove-orphans

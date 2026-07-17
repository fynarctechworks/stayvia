# Shortcuts for the Docker dev stack on Windows PowerShell.
# Usage: ./hoteldesk.ps1 <command>
#
# Run ./hoteldesk.ps1 help to list commands.

param(
  [Parameter(Position = 0)]
  [string]$Command = "help"
)

$ErrorActionPreference = "Stop"

function Invoke-Compose {
  param([string[]]$Args)
  & docker compose @Args
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

switch ($Command.ToLower()) {
  "help" {
    @"
Hoteldesk dev shortcuts

  build       Build all images
  up          Start the stack in the background
  down        Stop the stack (keeps volumes)
  restart     Restart api + web
  logs        Tail logs from all services
  ps          Show running containers
  api-shell   Open a shell inside the api container
  web-shell   Open a shell inside the web container
  psql        Open psql against the dev Postgres
  redis-cli   Open redis-cli against the dev Redis
  migrate     Run the API migrations against the running Postgres
  seed        Seed dev data
  test        Run API tests inside the container
  clean       Stop and remove containers but keep volumes
  nuke        Stop, remove everything INCLUDING volumes (wipes dev DB)
"@
  }
  "build"     { Invoke-Compose @("build") }
  "up"        { Invoke-Compose @("up", "-d") }
  "down"      { Invoke-Compose @("down") }
  "restart"   { Invoke-Compose @("restart", "api", "web") }
  "logs"      { Invoke-Compose @("logs", "-f", "--tail=200") }
  "ps"        { Invoke-Compose @("ps") }
  "api-shell" { Invoke-Compose @("exec", "api", "sh") }
  "web-shell" { Invoke-Compose @("exec", "web", "sh") }
  "psql"      { Invoke-Compose @("exec", "postgres", "psql", "-U", "hoteldesk", "-d", "hoteldesk") }
  "redis-cli" { Invoke-Compose @("exec", "redis", "redis-cli") }
  "migrate"   { Invoke-Compose @("exec", "api", "node", "apps/api/scripts/migrate.mjs") }
  "seed"      { Invoke-Compose @("exec", "api", "npx", "tsx", "apps/api/src/db/seed.ts") }
  "test"      { Invoke-Compose @("exec", "api", "npm", "test", "--workspace=@hoteldesk/api") }
  "clean"     { Invoke-Compose @("down", "--remove-orphans") }
  "nuke"      { Invoke-Compose @("down", "-v", "--remove-orphans") }
  default {
    Write-Host "Unknown command: $Command" -ForegroundColor Red
    Write-Host "Run ./hoteldesk.ps1 help for the list."
    exit 1
  }
}

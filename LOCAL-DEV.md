# Local development — fully offline in Docker Desktop

This runs the **entire** stack on your machine — Postgres, Auth, Redis, API,
and web — with **zero contact with production**. Production lives on Supabase
+ Upstash + the VPS and is never touched by anything here.

> **Why two pieces (Supabase CLI + docker-compose.local.yml)?**
> The app authenticates through Supabase (login, user management). A plain
> Postgres container can't do that. The Supabase CLI runs a *local* Supabase
> (Postgres + GoTrue auth + Studio) in Docker; our compose file adds Redis +
> API + web on top.

---

## One-time setup

### 1. Install the Supabase CLI
```powershell
# Option A — Scoop
scoop install supabase
# Option B — npm (global)
npm install -g supabase
```
Verify: `supabase --version`

### 2. Start the local Supabase stack
From the repo root:
```bash
supabase init     # first time only — creates ./supabase/
supabase start    # boots local Postgres + auth in Docker (takes ~1 min first run)
```
When it finishes it prints a block like:
```
API URL: http://localhost:54321
DB URL:  postgresql://postgres:postgres@localhost:54322/postgres
anon key:         eyJ...           <- web VITE_SUPABASE_ANON_KEY
service_role key: eyJ...           <- api SUPABASE_SERVICE_ROLE_KEY
JWT secret:       super-secret-...  <- api SUPABASE_JWT_SECRET
```
Keep this output handy.

### 3. Paste the local keys into the env files
These files are gitignored and pre-created with placeholders:

`apps/api/.env.local`
- `SUPABASE_SERVICE_ROLE_KEY` = the **service_role key**
- `SUPABASE_JWT_SECRET`       = the **JWT secret**

`apps/web/.env.local`
- `VITE_SUPABASE_ANON_KEY`    = the **anon key**

Also export the anon key for the web build arg (PowerShell):
```powershell
$env:VITE_SUPABASE_ANON_KEY = "<anon key>"
```

### 4. Bring up the app stack
```bash
docker compose -f docker-compose.local.yml up --build
```
- API  → http://localhost:3001  (health: /health)
- Web  → http://localhost:5180
- Supabase Studio → http://localhost:54323 (inspect the local DB)

### 5. Schema + seed the LOCAL database
The local Postgres starts empty. Apply migrations and seed the admin user.
Run these against the LOCAL db (NODE_ENV=local picks apps/api/.env.local):
```bash
# from apps/api, on the host (uses localhost, not host.docker.internal)
cd apps/api
NODE_ENV=local DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres node scripts/migrate.mjs
NODE_ENV=local DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres SUPABASE_URL=http://localhost:54321 npx tsx src/db/seed.ts
```
Log in at http://localhost:5180 with `admin@hoteldesk.local` / `ChangeMe123!`.

---

## Daily use
```bash
docker compose -f docker-compose.local.yml up        # start
docker compose -f docker-compose.local.yml down       # stop (keeps data)
supabase stop                                          # stop local Supabase
```

## Teardown / reset (LOCAL only — never affects prod)
```bash
docker compose -f docker-compose.local.yml down -v     # wipe local Redis
supabase stop --no-backup                              # wipe local DB
```

---

## Environment map

| Env | DB | Auth | Redis | Where it runs |
|-----|----|------|-------|---------------|
| **local** (`.env.local`) | Supabase CLI Postgres (54322) | Supabase CLI GoTrue (54321) | local Docker Redis | Docker Desktop |
| **production** (`.env.production`) | Supabase cloud | Supabase cloud | Upstash | VPS + Vercel |

`.env.development` is the legacy "dev points at cloud Supabase" config — leave
it alone or stop using it now that `.env.local` exists.

---

## Data-loss safety

- Nothing in this local setup connects to the production Supabase/Upstash.
- `docker compose ... down -v` and `supabase stop` only remove **local**
  volumes. Production is a remote managed service — Docker cannot delete it.
- The ONE risk: running `migrate.mjs` / `seed.ts` with the **production**
  `DATABASE_URL` loaded. The commands above pin the LOCAL `DATABASE_URL`
  explicitly so that can't happen by accident. Never paste the prod URL here.
- Recommended: keep a Supabase backup of prod (dashboard → Database → Backups)
  as insurance, independent of any local work.

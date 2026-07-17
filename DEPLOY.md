# Deploying Hoteldesk (SLDT Stay Inn)

Production architecture:

```
  sldt.infynarc.com       ──▶  Vercel Pro          ──▶  web (Vite static build)
  api.sldt.infynarc.com   ──▶  Hostinger VPS       ──▶  nginx (HTTPS) ──▶ Docker container  ──▶ API
                                                                  │
                                          Supabase (Postgres + Auth)  +  Upstash (Redis)
```

- **Web** → Vercel Pro (static SPA) at `sldt.infynarc.com`.
- **API** → Hostinger VPS (`187.127.129.90`) at `api.sldt.infynarc.com`,
  running as a Docker container, fronted by nginx which terminates HTTPS.
- **Database / Auth** → the existing Supabase project (reused for production).
- **Redis** → the existing Upstash instance (reused for production).
- **DNS** → the `infynarc.com` zone is already managed by **Vercel DNS**.
  The records for this app **already exist** (see step 2) — no DNS work needed.

> **Shared VPS.** `187.127.129.90` already hosts other apps' APIs
> (`api.infynarc.com`, `bmsapi.infynarc.com`). nginx routes them by
> hostname, so the Hoteldesk API just becomes one more nginx site + one
> more Docker container. The only thing to get right is the **port** —
> see step 3d.

Only the **API** and the **web bundle** are deployed by you. The data layer is
already cloud-hosted.

---

## 0. One-time prerequisites

- SSH access to the Hostinger VPS `187.127.129.90`.
- Vercel Pro account — the `sldt` project is already connected to the repo.
- The two production env files filled in (see step 1).
- DNS is already done (step 2 is just verification).

---

## 1. Fill the production env files

Two git-ignored files hold real values. They were pre-filled with the reused
Supabase/Upstash credentials and the real domains — you only need to
confirm/replace a few fields.

### `apps/api/.env.production`
Open it and replace:
- `SEED_ADMIN_PASSWORD` → a strong password (only used if you re-seed; the
  admin already exists in the DB, so this is low-stakes).
- `TWILIO_WHATSAPP_FROM` → your **approved** WhatsApp Business sender.
  If WhatsApp isn't approved yet, instead set `NOTIFICATIONS_PROVIDER=stub`
  to keep messaging disabled — the app works fine without it.

Everything else (DB, Supabase, Upstash, encryption key,
`FRONTEND_URL=https://sldt.infynarc.com`) is already correct for the
reused-infra setup. **Do not regenerate `ENCRYPTION_KEY`** — it must match the
key that encrypted data already in the DB, or KYC fields become unreadable.

### `apps/web/.env.production`
Already set: `VITE_API_URL=https://api.sldt.infynarc.com/api/v1`, Supabase URL
+ anon key, `VITE_UI_PREVIEW=false`. Nothing to change.

> The web build on Vercel does **not** read this local file — see step 4 for
> setting the same keys in the Vercel dashboard. This local file is only used
> by a local `npm run build`.

---

## 2. DNS — already configured (just verify)

`infynarc.com` DNS is managed in Vercel and the records this app needs
**already exist**:

| Record               | Type  | Points to            | Purpose       |
|----------------------|-------|----------------------|---------------|
| `sldt.infynarc.com`  | —     | Vercel `sldt` project| web           |
| `api.sldt.infynarc.com` | A  | `187.127.129.90`     | API → the VPS |

Confirm `api.sldt` resolves before the SSL step:
```bash
dig +short api.sldt.infynarc.com      # should print 187.127.129.90
```

If it does, skip ahead — there is no DNS to add.

---

## 3. Deploy the API to the Hostinger VPS

SSH in as a sudo-capable user. This VPS already runs other apps, so most
tooling is likely installed — the steps below are safe to run regardless
(they no-op if a package is already present).

### 3a. Ensure Docker + nginx + certbot are present
```bash
# Docker — skip if `docker --version` already works.
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

# nginx + certbot + git — apt install is a no-op if already installed.
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx git
```

### 3b. Get the code onto the VPS
Put it in its own directory so it never collides with the other apps:
```bash
cd /opt
sudo git clone <YOUR_REPO_URL> hoteldesk
sudo chown -R $USER:$USER hoteldesk
cd hoteldesk
```

### 3c. Create the API env file on the VPS
`apps/api/.env.production` is git-ignored, so it is NOT in the clone. Copy it
from your machine, or create it on the VPS:
```bash
# from your local machine:
scp apps/api/.env.production  user@187.127.129.90:/opt/hoteldesk/apps/api/.env.production
```
Or `nano apps/api/.env.production` on the VPS and paste the filled contents.
Lock it down:
```bash
chmod 600 apps/api/.env.production
```

### 3d. Pick a free host port (IMPORTANT — shared VPS)
The other apps on this VPS may already use port 3000. List what's listening:
```bash
sudo ss -tlnp | grep LISTEN
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```
Choose a port that does NOT appear in that output. The Hoteldesk compose
file defaults to **3010** — if 3010 is free, you're done, do nothing.
If 3010 is taken, export your chosen port before the next step:
```bash
export HOTELDESK_HOST_PORT=3011        # example — use any free port
```
> Whatever port you settle on, it must match the `proxy_pass` line in the
> nginx config (step 3f). The default in both files is 3010.

### 3e. Build & start the API container
```bash
cd /opt/hoteldesk
docker compose -f deploy/docker-compose.prod.yml up -d --build
```
First build takes a few minutes (it installs Chromium + fonts). Check it —
substitute your chosen port for `3010`:
```bash
docker compose -f deploy/docker-compose.prod.yml ps           # State "healthy"
docker compose -f deploy/docker-compose.prod.yml logs -f api  # watch the boot log
curl -s http://127.0.0.1:3010/health                          # {"status":"ok",...}
```

### 3f. Apply database migrations
The Supabase DB needs the latest schema. Run the migration script once,
from inside the container (it has the script + `DATABASE_URL`). The migrate
script refuses a non-local DB by default; on the VPS this IS the prod DB, so
pass `ALLOW_REMOTE_DB=1` to confirm the intent:
```bash
docker compose -f deploy/docker-compose.prod.yml exec -e ALLOW_REMOTE_DB=1 api \
  node apps/api/scripts/migrate.mjs
```
It prints which migrations applied. Safe to re-run — already-applied ones skip.

> Since production reuses the dev Supabase project, the schema is likely
> already up to date. The script will just report "already applied".

### 3g. nginx reverse proxy
This adds ONE more site file — it does not touch the other apps' configs.
First back up the existing nginx config (rollback safety net):
```bash
tar czf ~/nginx-backup-$(date +%F).tar.gz /etc/nginx
```

Install the site file. **Important — port 80 only at first.** nginx will
not pass `nginx -t` with an `ssl` listener that has no certificate yet, so
we install a port-80-only config and let certbot add the HTTPS block in 3h.
```bash
sudo mkdir -p /var/www/certbot
sudo tee /etc/nginx/sites-available/api.sldt.infynarc.com.conf >/dev/null <<'NGINXEOF'
server {
    listen 80;
    listen [::]:80;
    server_name api.sldt.infynarc.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:3010;   # match HOTELDESK_HOST_PORT
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 15m;
        proxy_connect_timeout 10s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
        proxy_buffering off;
    }
}
NGINXEOF
sudo ln -s /etc/nginx/sites-available/api.sldt.infynarc.com.conf \
           /etc/nginx/sites-enabled/
```
**If you chose a host port other than 3010**, change the `proxy_pass` line
above to match. Then test + reload (reload is graceful — the other apps on
this nginx keep serving):
```bash
sudo nginx -t          # must say "syntax is ok" / "test is successful"
sudo systemctl reload nginx
curl -s http://api.sldt.infynarc.com/health    # {"status":"ok",...}
```

### 3h. HTTPS via Let's Encrypt
DNS for `api.sldt.infynarc.com` already points at the VPS (step 2):
```bash
sudo certbot --nginx -d api.sldt.infynarc.com
```
certbot issues the cert AND rewrites the nginx site with a full HTTPS
server block (real `ssl_certificate` paths) + an HTTP→HTTPS redirect,
then reloads. Renewal is automatic (a systemd timer). Verify:
```bash
curl -s https://api.sldt.infynarc.com/health    # {"status":"ok",...} over HTTPS
```

### 3i. Firewall
The other apps already serve over HTTPS, so 80/443 are almost certainly
open already. If ufw is in use, these are no-ops if the rules exist:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'    # opens 80 + 443
```
The Hoteldesk container's host port is **not** opened — it binds to
`127.0.0.1` only, and nginx is the public door.

---

## 4. Deploy the web to Vercel

The Vercel project (`sldt`) is already connected to the GitHub repo, so a
push already triggers a build. Finish the configuration:

### 4a. Project settings
- **Root Directory:** repo root (`.`). The build is a monorepo build — do
  **not** set it to `apps/web`.
- Framework / build / output are read from the repo's `vercel.json`
  (`build:web`, output `apps/web/dist`). Don't override them.

### 4b. Environment variables (Production scope)
Vercel builds in its own environment and ignores the local
`apps/web/.env.production`. In **Project → Settings → Environment Variables**,
scope **Production**, set:

| Key                       | Value                                          |
|---------------------------|------------------------------------------------|
| `VITE_API_URL`            | `https://api.sldt.infynarc.com/api/v1`         |
| `VITE_SUPABASE_URL`       | `https://wujndnaasfyzxpmaatcj.supabase.co`     |
| `VITE_SUPABASE_ANON_KEY`  | (the anon key from `apps/web/.env.production`)  |
| `VITE_UI_PREVIEW`         | `false`                                        |

After adding/changing env vars, **redeploy** so the build picks them up
(Deployments → ⋯ → Redeploy, or push a commit).

### 4c. Custom domain
- Project → **Domains** → add `sldt.infynarc.com`.
- Since DNS is on Vercel, it wires the CNAME automatically — the "Invalid
  Configuration" warning clears once the record propagates.

### 4d. Deploy
Push to the production branch (or hit **Deploy**). Vercel runs the build and
serves the SPA. Every later push auto-deploys.

---

## 5. Point Supabase Auth at the production domain

In the Supabase dashboard → **Authentication → URL Configuration**:
- **Site URL:** `https://sldt.infynarc.com`
- **Redirect URLs:** add `https://sldt.infynarc.com/**`

Without this, sign-in / password-reset links resolve to localhost.

---

## 6. Smoke test

1. `https://sldt.infynarc.com` loads, no console errors.
2. Log in as the admin (`sldt@sldtstayinn.com`).
3. Dashboard loads data — confirms web → API → Supabase + Upstash all wired.
4. Open a reservation → **Preview Invoice** — confirms Puppeteer/Chromium
   renders a PDF inside the container.
5. `curl -s https://api.sldt.infynarc.com/health` → `{"status":"ok"}`.

---

## 7. Updating after a code change

**Web:** `git push` → Vercel auto-builds and deploys. Nothing else.

**API (on the VPS):**
```bash
cd /opt/hoteldesk
git pull
docker compose -f deploy/docker-compose.prod.yml up -d --build
# if the change includes a new migration (ALLOW_REMOTE_DB=1 confirms the
# prod DB target — the guard blocks non-local DBs by default):
docker compose -f deploy/docker-compose.prod.yml exec -e ALLOW_REMOTE_DB=1 api \
  node apps/api/scripts/migrate.mjs
```
`up -d --build` rebuilds the image and replaces the running container with
near-zero downtime. The old container is stopped only after the new one is up.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Web loads but every API call fails (CORS) | `FRONTEND_URL` in `apps/api/.env.production` must exactly equal `https://sldt.infynarc.com` (no trailing slash, right scheme). Restart the container after editing. |
| Container shows `unhealthy` | `docker compose -f deploy/docker-compose.prod.yml logs api` — usually a bad env value (DB unreachable, malformed `ENCRYPTION_KEY`). The env schema prints exactly which key failed. |
| `502 Bad Gateway` from nginx | API container isn't up, or the nginx `proxy_pass` port doesn't match the container's host port. Check `docker ps` and `curl http://127.0.0.1:<HOST_PORT>/health` on the VPS — the port in the nginx config must equal `HOTELDESK_HOST_PORT` (default 3010). |
| Vercel domain stuck on "Invalid Configuration" | The `sldt` CNAME hasn't propagated, or a conflicting record exists in the Vercel DNS panel. Re-check the record and hit Refresh. |
| PDF preview hangs / errors | Chromium issue in the container — `docker compose ... logs api` around the request. The image bundles Chromium + fonts; a clean rebuild usually fixes a corrupted layer. |
| Login redirects to localhost | Supabase Auth URL Configuration not updated — see step 5. |
| certbot fails | DNS for `api.sldt.infynarc.com` not resolving to `187.127.129.90` yet, or port 80 blocked. Other apps on this VPS already use 80/443, so this is unlikely — check `dig +short api.sldt.infynarc.com`. |
| Port collision on `up` ("address already in use") | Another app on the VPS holds the chosen host port. Pick a free one (`sudo ss -tlnp`), `export HOTELDESK_HOST_PORT=<free>`, re-run `up`, and update the nginx `proxy_pass` to match. |

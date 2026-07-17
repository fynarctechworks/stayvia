# HotelDesk Deployment

## Architecture

- **Frontend (`apps/web`)**: Static Vite build → Vercel
- **API (`apps/api`)**: Node 20 process behind Nginx on an Ubuntu 22.04 VPS, managed by PM2
- **Database + Auth + Storage**: Supabase (managed Postgres + GoTrue + private `kyc-docs` bucket)
- **Cache / PubSub**: Upstash Redis (REST + `rediss://` for ioredis)
- **PDF**: Puppeteer using the VPS-installed Chromium. Needs `--no-sandbox` and the system deps listed below

## VPS provisioning (Ubuntu 22.04)

```bash
# Node 20 + build tooling
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential git nginx certbot python3-certbot-nginx

# Chromium runtime deps for Puppeteer
sudo apt-get install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 \
  libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
  libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
  libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release \
  wget xdg-utils

sudo npm install -g pm2
```

## Supabase Storage setup

Create a **private** bucket named `kyc-docs` (Supabase dashboard → Storage → New bucket → toggle "Public" OFF). The API uses the service-role key to upload and issues 5-minute signed URLs for viewing. No direct public access.

## Deploy steps

```bash
# as deploy user
sudo mkdir -p /srv/hoteldesk && sudo chown $USER:$USER /srv/hoteldesk
cd /srv/hoteldesk
git clone <repo>.git .

# install & build
npm install
npm -w @hoteldesk/shared run build
npm -w @hoteldesk/api run build

# env
cp .env.example apps/api/.env
$EDITOR apps/api/.env   # fill in all secrets. See root .env.example

# schema + seed (first deploy only)
npm -w @hoteldesk/api run db:push
npm -w @hoteldesk/api run db:seed

# start under PM2
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd      # follow printed command
```

## Nginx + TLS

```bash
sudo cp deploy/nginx.conf.sample /etc/nginx/sites-available/hoteldesk-api
sudo ln -sf /etc/nginx/sites-available/hoteldesk-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.hoteldesk.example.com
```

## Frontend (Vercel)

```bash
# from apps/web
npx vercel link
npx vercel env add VITE_API_URL production       # https://api.hoteldesk.example.com/api/v1
npx vercel env add VITE_SUPABASE_URL production
npx vercel env add VITE_SUPABASE_ANON_KEY production
npx vercel --prod
```

Build command: `npm -w @hoteldesk/shared run build && npm -w @hoteldesk/web run build`
Output: `apps/web/dist`

## Updating

```bash
cd /srv/hoteldesk
git pull
npm install
npm -w @hoteldesk/shared run build
npm -w @hoteldesk/api run build
# schema migrations (if any)
npm -w @hoteldesk/api run db:push
pm2 reload hoteldesk-api
```

## Log rotation

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
```

## Healthchecks

- `GET https://api.hoteldesk.example.com/health` → `{ status: "ok" }`
- Uptime should poll `/health` every 60s; alert on 2 failures.

## Backups

Supabase handles Postgres PITR. For a belt-and-braces nightly dump:

```bash
0 2 * * * pg_dump "$DATABASE_URL" | gzip > /var/backups/hoteldesk-$(date +\%F).sql.gz
```

## Security checklist

- `ENCRYPTION_KEY` is a fresh 64-char hex (`openssl rand -hex 32`). **Never** rotate without re-encrypting guest ID rows
- `SUPABASE_SERVICE_KEY` stays server-side only; never ship to the browser
- UFW: only `22`, `80`, `443` open
- Nginx adds HSTS, X-Frame-Options, nosniff
- Rate limits are on by default; adjust in `apps/api/src/middleware/rateLimit.ts` if needed

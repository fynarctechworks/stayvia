# HotelDesk

Internal hotel management system for 10–20 room walk-in properties.
React + Node.js + Supabase + Upstash Redis.
See `HotelDesk_PRD.docx` and `HotelDesk_TRD.docx` for full specs.

## Status: MVP complete (all 14 days)

| Phase | Days | Scope | State |
| :--- | :--- | :--- | :--- |
| 1 | 1–4 | Monorepo, schema, auth, rooms, guests | done |
| 2 | 5–9 | Reservations, check-in/out, invoices, payments, housekeeping | done |
| 3 | 10–12 | Dashboard + cache, reports, settings + staff | done |
| 4 | 13–14 | Puppeteer PDF, Vitest unit tests, deploy notes | done |

## Stack

- **Frontend**: React 18, Vite 6, TanStack Query v5, React Router v7, Tailwind, Recharts, PapaParse
- **Backend**: Node 20, Express, Drizzle ORM, postgres-js, Zod, pino
- **Data**: Supabase (Postgres + Auth), Upstash Redis (REST + pub/sub)
- **PDF**: Puppeteer (persistent browser instance, `--no-sandbox` for VPS)
- **Security**: AES-256-GCM for guest ID proofs, rate limiting, role-gated routes

## Setup

### Prereqs

- Node.js 20+
- Supabase project (URL, anon key, service role key)
- Upstash Redis instance (REST URL + token, and `rediss://` URL for ioredis)

### 1. Install

```bash
npm install
```

### 2. Configure env

```bash
cp .env.example apps/web/.env   # keep only VITE_*
cp .env.example apps/api/.env   # keep server-side secrets
```

Generate encryption key (DO NOT rotate after seeding):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Schema + seed

```bash
npm -w @hoteldesk/api run db:push
npm -w @hoteldesk/api run db:seed
```

Default admin is created from `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` in `.env`.

### 4. Run

```bash
npm run dev:api     # http://localhost:4000
npm run dev:web     # http://localhost:5173
```

### 5. Tests

```bash
npm -w @hoteldesk/api run test
```

Covers GST slab logic, date-range overlap, and invoice total math.

## Project tree

```
apps/
  api/
    src/
      config/env.ts         Zod-validated env
      db/
        client.ts           drizzle + postgres-js
        schema/             13 tables
        seed.ts
      lib/
        crypto.ts           AES-256-GCM
        gst.ts              slab logic + CGST/SGST split
        availability.ts     daterange overlap, sequence generators
        settings.ts         60s cached settings
        numbers.ts          RES-YYYYMMDD / INV-YYYYMM
        redis.ts            Upstash + ioredis + dashboard invalidation
        pdf.ts              Puppeteer pool + invoice HTML
        activity.ts, response.ts, supabase.ts, logger.ts
      middleware/           auth, error, rateLimit, validate
      routes/               auth, rooms, guests, reservations, invoices,
                            payments, housekeeping, dashboard, reports, settings
      index.ts              express bootstrap + shutdown hooks
  web/
    src/
      auth/                 AuthContext, guards
      components/           Sidebar, AppShell, StatusBadge
      lib/                  api.ts, supabase.ts, utils.ts
      pages/                Login, Dashboard, Rooms, RoomDetail,
                            Reservations, NewReservation, ReservationDetail,
                            Guests, GuestProfile, Housekeeping, Reports, Settings
packages/
  shared/                   Zod schemas + enums
deploy/
  ecosystem.config.cjs      PM2 config
  nginx.conf.sample         TLS + proxy
  README.md                 VPS + Vercel deploy steps
```

## API surface (v1)

| Method | Path | Roles |
| :--- | :--- | :--- |
| POST | `/auth/login`, `/auth/logout`, GET `/auth/me` | public / authed |
| GET/POST/PUT | `/rooms`, `/rooms/:id`, `/rooms/availability` | admin + frontdesk |
| GET/POST/PUT | `/guests`, `/guests/:id`, `/guests/check-duplicate` | admin + frontdesk |
| full | `/reservations`, `/reservations/:id/check-in`, `/check-out`, `/cancel`, `/swap-room`, `/charges` | admin + frontdesk |
| full | `/invoices`, `/invoices/:id/pdf`, `/invoices/:id/void` | admin (void only) |
| full | `/payments` | admin + frontdesk |
| full | `/housekeeping` + `/maintenance` + `/resolve` | all roles (resolve = admin) |
| GET | `/dashboard` (30s cache) | admin + frontdesk |
| GET | `/reports/{occupancy,revenue,collections,gst-summary,outstanding,room-performance,guests}` | admin |
| full | `/settings`, `/staff` | admin |

## Notes

- **Double-booking** is prevented by half-open `daterange(check_in, check_out, '[)')` overlap in Postgres. See `apps/api/src/lib/availability.ts`.
- **GST**: rate snapped at reservation creation from `ratePerNight` slab (<₹1000 → 0%, ₹1000–7500 → 5%, >₹7500 → 18%); CGST/SGST are equal halves.
- **Invoice numbers**: `INV-YYYYMM-XXXX`, per-month monotonic sequence.
- **Dashboard cache**: Upstash 30s TTL; pub/sub channel `dashboard:invalidate` clears it on any mutation.
- **PDF**: Persistent Puppeteer browser; closes on SIGTERM/SIGINT.

## Deploy

See [`deploy/README.md`](deploy/README.md) for VPS + Vercel + Nginx + Certbot + PM2 steps.

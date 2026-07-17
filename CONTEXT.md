# SLDT Stay Inn — Hotel Management System

A single-tenant property management system (PMS) built for **SLDT Stay Inn**, a small hotel in Sabbavaram, Visakhapatnam (Andhra Pradesh, India). The system was originally scaffolded as a generic "HotelDesk" template and then specialized for this one property — package names and a few historical references still say `hoteldesk`, the user-facing brand is **SLDT Stay Inn**.

**Platform:** web-only (no native app), and now **fully responsive — phone, tablet, and desktop**. On phones (<768px) it presents a phone-first UI: a **bottom tab bar** (`components/BottomNav.tsx` — Home / Bookings / Rooms / Guests / More) instead of the sidebar, **stacked card layouts** for the data pages (Reservations, Invoices, Expenses, Guests render cards; Collections/Credits/Reports tables scroll horizontally), **bottom-sheet modals** (`ModalShell`, OTP, KYC slide up full-width), and a **one-pane Messages** view (list-or-chat with a back button). On `md+` (tablet/desktop — the front-desk target device) the original layout is unchanged: fixed left sidebar, dense multi-column tables, centered modals. The breakpoint switches between them; the desktop experience is never degraded.

This document is the comprehensive reference for everything in the codebase. It is intentionally exhaustive — read top-to-bottom for full context, or jump to a section.

---

## ⚡ Recent major changes (June 2026) — READ THIS FIRST

Several core behaviours changed after the original draft of this document. Where an older section below contradicts this list, **this list wins**; the relevant sections have been patched but skim here first.

### 1. Invoice model: ONE combined invoice per stay; per-room is print-only
The biggest change. **Revenue lives on the reservation + a single combined tax invoice.** Per-room "invoices" are no longer separate money-bearing records by default.

- **Checkout defaults to ONE combined invoice** (the modal's default radio; per-room is an opt-in for the rare standalone-GST-invoice case).
- **Per-room bills are presentation-only PDFs** rendered on demand from the combined invoice — `GET /invoices/:id/room-bill/:roomNumber/pdf`. They carry the parent invoice number with a `· Room N` suffix, a "not a separate tax invoice" banner, and create **zero** DB rows / GST / money. UI: small per-room buttons on a combined invoice row in `ReservationDetail`.
- **Auto-consolidation at final checkout**: when the last room of a multi-room stay checks out via the per-room flow AND every per-room invoice is fully paid, they are automatically merged into one combined invoice (`autoConsolidatePerRoomInvoices` in `reservations.ts`). Safe no-money bookkeeping. So even per-room checkout ends with one combined invoice.
- The old **"Reissue invoices" / convert-between-shapes UI is removed** (the endpoint `convert-invoices` still exists but is no longer surfaced). It caused double-billing tangles.

### 2. Credit notes (migration 0042)
`invoices` now doubles as a credit-note store via `document_type` (`'invoice' | 'credit_note'`) + `credit_note_for` (self-FK) + a `sldt_credit_note_seq` sequence (`SLDT-CN-NNNN`). A credit note is a negative-amount reversal of a paid invoice (GST-correct way to change a settled bill). The GST report nets credit notes out of period tax. Reversed pairs collapse behind a "Show reversed" toggle on the reservation page.

### 3. Complimentary reservations go fully silent
Marking a reservation complimentary now hides it **everywhere except the Complimentary report** (retroactively): no notifications (and conversion deletes any it already generated), no guest/owner WhatsApp, no arrival reminders, no no-show banner, excluded from activity feed, calendar, global search, reservation list, guest-profile stay history, the Invoices page, and all revenue/GST/occupancy reports. **Kept visible:** dashboard room tiles/occupancy and housekeeping tasks (a comp guest physically occupies the room).

### 4. IST date filters everywhere
All `date_from`/`date_to` filters (invoices, payments, activity, audit, reports, GST) interpret `yyyy-MM-dd` as a **full property-local (IST) calendar day** via `lib/propertyTime.ts` (`propertyDayStart`/`propertyDayEnd`). Previously single-day windows like "Today" matched nothing or were skewed on a UTC server.

### 5. Conflict-aware availability + extend-continue
- `findAvailableRooms` only hides physically-occupied/dirty rooms when the search window **includes today**; future-dated searches go by date-overlap alone. Opt-in `include_conflicts=1` returns conflicted rooms flagged so the booking picker shows them as disabled "BOOKED" cards instead of hiding them.
- New `GET /reservations/:id/extend-options` (per-room availability for the extension window + free alternative rooms) and `POST /reservations/:id/extend-continue` (OTP-verified continuation booking in a different room for the same guest).

### 6. Other
- **Daily Report** (`/reports/daily-ledger` + Reports tab): per-day rooms, guests, nightly price, collected, expenses, net + CSV.
- **Sticky filter bars** on all list pages (`components/StickyBar.tsx`).
- **Cancel + no-show** now dispatch in-app notifications.
- **Equal advance split** at per-room checkout (was proportional).
- **Per-payment totals** on invoice/receipt PDFs (each payment itemised, not an advance/later summary).
- **Calendar** day-details now open in a modal; **Messages** rewritten WhatsApp-style; **Expenses** rows open a detail page (inline actions removed) with an "EDITED" chip.
- **Refund method is never preselected** — staff must choose cash vs wallet explicitly.

---

## Table of contents

1. [Big picture](#big-picture)
2. [Tech stack](#tech-stack)
3. [Repository layout](#repository-layout)
4. [Environment configuration](#environment-configuration)
5. [Authentication and roles](#authentication-and-roles)
6. [Data model — every table explained](#data-model)
7. [API surface — every route explained](#api-surface)
8. [Web app — every page and component explained](#web-app)
9. [Business rules and core flows](#business-rules-and-core-flows)
10. [Notifications and messaging (WhatsApp via Twilio)](#notifications-and-messaging)
11. [PDF documents (invoice, receipt, check-in slip)](#pdf-documents)
12. [GST and money handling](#gst-and-money-handling)
13. [Document numbering](#document-numbering)
14. [Settings, templates, and customization](#settings-templates-and-customization)
15. [Observability and ops](#observability-and-ops)
16. [Migration scripts](#migration-scripts)
17. [Known issues and gotchas](#known-issues-and-gotchas)
18. [Development workflow](#development-workflow)

---

## Big picture

### What this software does, in one paragraph

A small hotel runs day-to-day operations on this app. Front-desk staff create reservations (pre-bookings phoned/whatsapp'd in or walk-ins arriving at the door), upload guest ID (KYC) photos, check guests in, optionally collect an advance, generate the final tax invoice on check-out, send WhatsApp messages to the guest and the owner at every step, and track unpaid balances for trusted regulars. The owner gets WhatsApp alerts and a dedicated "Collections" view for money owed. Rooms move through a housekeeping cycle (dirty → clean → inspected → available) that staff manage from the dashboard.

### Why this specific architecture

- **Single-tenant.** One hotel, one Supabase project, one Twilio account. Nothing here is multi-tenant. The schema has no `tenant_id`. There are no plans for a SaaS pivot.
- **Indian-tax-aware.** GST slabs (0/5/18%) baked into reservation pricing. CGST + SGST split is automatic. Invoices follow Indian format conventions.
- **Front-desk-first, tablet/desktop target.** Every screen optimised for a receptionist at a counter on a tablet or PC — often interrupted, juggling guests. Dense tables, optimistic updates, big tap targets. Responsive down to phone size (stacking/scrolling), but the desk device is the design target, not a phone in the hand.
- **Owner observability built-in.** The hotel owner is treated as a primary stakeholder, not just a user — separate WhatsApp alerts, a dedicated Collections page, and outstanding-balance reports.

### The 4 main verbs the system supports

| Verb | Where it happens | What changes |
|---|---|---|
| **Book** | `/reservations/new?mode=booking` | A future reservation is created with an advance optionally collected; rooms blocked. |
| **Check in** | `/reservations/<id>` "Verify & Check In", or `/reservations/new?mode=walkin` | Reservation flips to `checked_in`, room → `occupied`, KYC must be on file, advance can be collected, OTP can be required, WhatsApp fires. |
| **Check out** | `/reservations/<id>` "Check Out & Generate Invoice" | **One combined tax invoice** is computed (all room nights × rate + extras, GST split — combined is the default), payment is taken or marked **unpaid**, rooms → `dirty`, WhatsApp + invoice link fires. Per-room bills print from the combined invoice on demand. |
| **Collect later** | Settings → Collections → "Mark Received" | A pending payment row flips from `pending` → `received`, invoice flips to `paid`. |

Everything else is supporting infrastructure for those four flows.

---

## Tech stack

### Frontend (`apps/web`)

| Layer | Choice | Why |
|---|---|---|
| Build/dev | **Vite 6** | Fast HMR; Vite's network-host server is critical for tablet testing |
| Framework | **React 18** + TypeScript | Industry standard; strict TS for safety |
| Routing | **react-router-dom 7** | Declarative routes |
| Server state | **TanStack Query 5** | Caching, optimistic updates, refetch-on-focus discipline |
| Forms | Plain React state + `zod` for client-side validation when needed | Forms here are simple enough that a form library would be overkill |
| Styling | **Tailwind CSS 3** + custom theme tokens | Brand jade/brass palette in `tailwind.config.ts` |
| Icons | **lucide-react** | Consistent stroke-based set |
| Auth | **@supabase/supabase-js** | JWT via Supabase Auth |
| Date | **date-fns** | Functional, no dayjs/moment |
| CSV | **papaparse** | Used in Reports export |
| PDF preview | None — PDFs are rendered server-side (Puppeteer) and downloaded |

### Backend (`apps/api`)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 20+** with **tsx** loader (via `npx tsx src/index.ts`) | No build step in dev; tsx compiles TS on the fly |
| HTTP | **Express 4** | Familiar; middleware ecosystem |
| ORM | **Drizzle ORM** with `postgres-js` driver | Lightweight, type-safe, no migrations CLI complexity |
| DB | **Supabase Postgres** (managed) | Auth + DB + Storage in one place |
| Cache | **Upstash Redis** REST + ioredis pub/sub | Optional — used for dashboard caching only |
| Auth verify | Supabase JWT → `supabaseAdmin.auth.getUser(token)` per request | Middleware in `middleware/auth.ts` |
| Validation | **Zod** schemas (shared with frontend via `@hoteldesk/shared` workspace package) | Single source of truth |
| PDF | **Puppeteer** (headless Chromium) | Render HTML to PDF for invoices, receipts, slips |
| Logs | **pino** + **pino-http** | Structured JSON logs |
| Rate limit | **express-rate-limit** | Per-route throttling |
| Crypto | Node `crypto` for AES-256-GCM ID encryption | KYC IDs are encrypted at rest |
| Files | **multer** for multipart uploads | KYC photo upload |
| Email | (Disabled — see Notifications section) | Original Resend integration was removed in favour of WhatsApp-only |
| SMS/WhatsApp | **Twilio REST API** (no SDK — direct fetch with Basic auth) | Sandbox by default, production-ready |

### Shared (`packages/shared`)

Workspace package consumed by both apps via `@hoteldesk/shared`. Holds:
- Zod schemas for create/update payloads (so client and server validate identically)
- Enum constants (roles, statuses, payment methods, etc.)

---

## Repository layout

```
hoteldesk/
├── apps/
│   ├── api/                       # Express + Drizzle backend
│   │   ├── .env                   # Real secrets (gitignored)
│   │   ├── drizzle.config.ts
│   │   ├── package.json
│   │   ├── scripts/               # One-off migrations & maintenance
│   │   └── src/
│   │       ├── config/env.ts      # Zod-validated env loader
│   │       ├── db/
│   │       │   ├── client.ts      # Drizzle + postgres-js connection
│   │       │   ├── schema/        # One file per table
│   │       │   │   ├── activity.ts
│   │       │   │   ├── enums.ts
│   │       │   │   ├── guests.ts
│   │       │   │   ├── invoices.ts
│   │       │   │   ├── messageTemplates.ts
│   │       │   │   ├── messages.ts
│   │       │   │   ├── notifications.ts
│   │       │   │   ├── otps.ts
│   │       │   │   ├── profiles.ts
│   │       │   │   ├── reservations.ts
│   │       │   │   ├── rooms.ts
│   │       │   │   ├── settings.ts
│   │       │   │   └── index.ts   # Barrel
│   │       │   └── seed.ts        # Initial admin + settings row
│   │       ├── lib/               # Domain helpers
│   │       │   ├── activity.ts    # logActivity() wrapper
│   │       │   ├── availability.ts # findAvailableRooms, sequence helpers
│   │       │   ├── crypto.ts      # AES-256-GCM for ID numbers
│   │       │   ├── gst.ts         # GST slab calculation
│   │       │   ├── messaging.ts   # Twilio WhatsApp + email no-op
│   │       │   ├── notify.ts      # dispatchNotification, notifyOwner, etc.
│   │       │   ├── numbers.ts     # SLDT-RES/INV/RCP-NNNN format
│   │       │   ├── otp.ts         # generate/hash/expire helpers
│   │       │   ├── propertyTime.ts # IST day-bound helpers for date filters
│   │       │   ├── pdf.ts         # Puppeteer renderers (invoice, credit note, room bill, receipt)
│   │       │   ├── receipt.ts     # generateReceiptNumber
│   │       │   ├── redis.ts       # Cache + pub/sub for dashboard
│   │       │   ├── response.ts    # ok(), fail(), list() helpers
│   │       │   ├── settings.ts    # Cached getSettings()
│   │       │   ├── storage.ts     # Supabase Storage helpers (KYC + docs)
│   │       │   ├── supabase.ts    # Service-role client
│   │       │   └── templates.ts   # Message-template render + cache
│   │       ├── middleware/
│   │       │   ├── auth.ts        # requireAuth, requireRole, requireAdmin
│   │       │   ├── error.ts       # Global error handler
│   │       │   ├── rateLimit.ts   # Login + read + write limiters
│   │       │   └── validate.ts    # Zod request validator
│   │       ├── routes/            # One file per resource
│   │       │   ├── auth.ts
│   │       │   ├── dashboard.ts
│   │       │   ├── guests.ts
│   │       │   ├── housekeeping.ts
│   │       │   ├── invoices.ts
│   │       │   ├── messages.ts
│   │       │   ├── notifications.ts
│   │       │   ├── otp.ts
│   │       │   ├── payments.ts
│   │       │   ├── reports.ts
│   │       │   ├── reservations.ts
│   │       │   ├── rooms.ts
│   │       │   └── settings.ts
│   │       └── index.ts           # App bootstrap
│   └── web/                       # Vite + React frontend
│       ├── .env, .env.local       # Frontend env (gitignored)
│       ├── public/
│       │   ├── logo.jpg           # SLDT peacock logo (used in sidebar, login, PDFs)
│       │   └── SLDT LOGO.jpg      # Same file, original filename
│       ├── tailwind.config.ts     # Brand tokens
│       ├── vite.config.ts
│       └── src/
│           ├── App.tsx            # Routes
│           ├── main.tsx           # Provider tree
│           ├── styles.css         # Tailwind base + component classes
│           ├── auth/              # AuthContext + ProtectedRoute + RoleGuard
│           ├── components/        # Reusable UI
│           ├── hooks/             # Custom hooks (e.g. useRoomTypes)
│           ├── lib/               # api.ts, supabase.ts, utils.ts, mock-data.ts
│           └── pages/             # One file per route
├── packages/
│   └── shared/
│       ├── package.json
│       └── src/
│           ├── enums.ts
│           ├── index.ts
│           └── schemas/
│               ├── guest.ts
│               ├── reservation.ts
│               ├── room.ts
│               └── settings.ts
├── deploy/
│   ├── README.md                  # Production deployment guide
│   ├── ecosystem.config.cjs       # PM2 config
│   └── nginx.conf.sample          # Nginx reverse-proxy config
├── HotelDesk_PRD.docx
├── HotelDesk_TRD.docx
├── README.md
├── CONTEXT.md                     # This file
├── .env.example                   # Template for all env vars
├── .gitignore
├── package.json                   # Root workspace
└── package-lock.json
```

---

## Environment configuration

### `apps/api/.env` — backend secrets

```bash
NODE_ENV=development
PORT=3001                          # Frontend points here

# Supabase
DATABASE_URL=postgresql://postgres.<ref>:<pwd>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # Server-only, never expose
SUPABASE_JWT_SECRET=<long secret>  # Used for verifying JWTs

# Upstash Redis (optional — caching only)
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...
UPSTASH_REDIS_URL=rediss://default:<pwd>@...upstash.io:6379

# Encryption (32-byte hex for AES-256-GCM, used for guest ID numbers)
ENCRYPTION_KEY=<64-char hex>       # NEVER rotate without re-encrypting all guest rows

# CORS — frontend origin
FRONTEND_URL=http://localhost:5180

# Bootstrap admin (used by db:seed)
SEED_ADMIN_EMAIL=sldt@sldtstayinn.com
SEED_ADMIN_PASSWORD=<password>
SEED_ADMIN_NAME=SLDT Admin

# Notifications
NOTIFICATIONS_PROVIDER=live         # 'stub' for dev (logs only), 'live' for real Twilio
HOTEL_DISPLAY_NAME=SLDT Stay Inn

# Twilio WhatsApp
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=<token>
TWILIO_WHATSAPP_FROM=+14155238886   # Sandbox; replace with approved sender for production
TWILIO_MESSAGING_SERVICE_SID=       # Optional; alternative to FROM number

# OTP defaults
OTP_LENGTH=6
OTP_TTL_SECONDS=300                 # 5 minutes
OTP_MAX_ATTEMPTS=5
```

### `apps/web/.env.local` — frontend

```bash
VITE_API_URL=http://localhost:3001/api/v1
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...        # Anon key, OK to expose to browser
VITE_UI_PREVIEW=false                # If true, app runs against in-memory mock data
```

### How env loading works

- **API**: `src/config/env.ts` parses `process.env` against a Zod schema. Empty strings are coerced to `undefined`. App refuses to boot if required vars are missing or malformed.
- **Web**: Vite reads `VITE_*` prefixed vars at build time and exposes them as `import.meta.env.VITE_API_URL`. Vite reloads `.env*` only on dev-server restart, **not** HMR.

---

## Authentication and roles

### Identity

- Auth is fully delegated to **Supabase Auth** (GoTrue under the hood).
- Login = email + password. No social, no magic link.
- Frontend calls `supabase.auth.signInWithPassword()` directly (not via API). The session JWT is stored in `localStorage` under `hoteldesk.session` (configured in `apps/web/src/lib/supabase.ts`).
- Frontend attaches `Authorization: Bearer <jwt>` to every API call.
- API middleware (`requireAuth`) verifies the JWT via `supabaseAdmin.auth.getUser(token)`, then loads the matching row from the local `profiles` table.

### The `profiles` table

A row in `profiles` is **the** application identity. It mirrors the Supabase Auth user (`profiles.id` = Auth user UUID) and adds:
- `fullName` — display name
- `role` — one of `admin` / `frontdesk` / `housekeeping`
- `phone` — optional staff phone
- `isActive` — soft-delete flag (deactivated users can't sign in app-side; their token still validates against Supabase Auth, but `requireAuth` rejects them)

**Two-step user creation** in `routes/settings.ts`:
1. `supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true })` — creates the auth user
2. `db.insert(profiles)` with the same UUID — creates the application row

**Two-step user deletion**:
1. Soft delete: `DELETE /staff/:id` flips `isActive = false`. Reversible.
2. Hard delete: `DELETE /staff/:id/hard` — refuses if the user has historical references (reservations, invoices, payments, activity log). Otherwise removes from `profiles` and Supabase Auth atomically.

### Roles and what they can do

| Role | Can do | Cannot |
|---|---|---|
| `admin` | Everything. Manage staff, edit settings, see Reports, see Collections, hard-delete payments, void invoices. | — |
| `frontdesk` | Create reservations, check guests in/out, record payments, edit room rates, manage housekeeping. | Edit settings, manage staff, see Reports/Collections, void payments |
| `housekeeping` | View housekeeping board, mark rooms clean/dirty/inspected, send/receive staff messages. | Reservation, payment, settings — anything money or guest-data related |

Role gates are enforced in two places:
- **Server**: `requireRole(...)` middleware on every route.
- **Web**: `<RoleGuard allow={[...]}>` component wraps pages; sidebar nav items have a `roles` filter.

### The seed admin

- Created on first run by `npm run db:seed --workspace=@hoteldesk/api`.
- Defaults from `.env`: `sldt@sldtstayinn.com` / `sldt@789`.
- This user is intended to be the hotel owner. Change the password from Settings → Staff → Edit immediately on a fresh install.

### Self-protection rules

- A user **cannot demote their own role** away from admin (would lock themselves out).
- A user **cannot deactivate themselves**.
- Hard-delete refuses to remove the last active admin.

---

## Data model

Each table below lists every column and what it's for. Schemas live in `apps/api/src/db/schema/`.

### `profiles`

| Column | Type | Purpose |
|---|---|---|
| `id` | uuid PK | Same UUID as the matching `auth.users` row |
| `full_name` | text | Display name |
| `email` | text unique | Login email (mirror of auth.users.email) |
| `role` | text enum | admin / frontdesk / housekeeping |
| `is_active` | bool default true | Soft-delete flag |
| `phone` | text | Optional |
| `created_at`, `updated_at` | timestamptz | Audit |

### `settings` (single-row table)

The hotel's configuration. There is exactly one row — created by `db:seed`, edited via Settings UI.

**Hotel identity:**
| Column | Use |
|---|---|
| `hotel_name` | "SLDT Stay Inn" — printed on every doc |
| `hotel_address` | Full postal address |
| `hotel_phone` | Front-desk number; included in WhatsApp templates |
| `hotel_email` | Optional contact email |
| `hotel_gstin` | GST registration; required on invoices |
| `hotel_logo_url` | Public URL to logo image (Supabase Storage `public-assets` bucket); embedded in PDFs |

**Operational policy:**
| Column | Use |
|---|---|
| `check_in_time` (default 12:00) | Hotel policy time, displayed on receipt |
| `check_out_time` (default 11:00) | Hotel policy time |
| `currency_symbol` (default ₹) | All money formatting |
| `invoice_prefix` (default INV) | Legacy — kept for backward compat; new format hard-codes `SLDT-INV-` |

**GST slabs (Indian hotel-room rules):**
| Column | Default | Rule |
|---|---|---|
| `gst_slab_exempt_below` | 1000 | If room rate < this, GST = 0% |
| `gst_slab_low_rate` | 5 | Applied when rate is between exempt and low_max |
| `gst_slab_low_max` | 7500 | Boundary |
| `gst_slab_high_rate` | 18 | Applied when rate ≥ low_max |
| `additional_charge_default_gst` | 18 | Default GST for ad-hoc charges |

**Document layout (printable PDFs):**
| Column | Use |
|---|---|
| `doc_primary_color` (#0F3D2E) | Brand jade — header, totals border |
| `doc_accent_color` (#B08A4A) | Brand brass — accents |
| `doc_invoice_title`, `doc_receipt_title` | Header text on PDFs |
| `doc_footer_text` | Bottom-of-page line |
| `doc_terms_text` | Optional T&C block |
| `doc_signatory_label` (default "Authorised Signatory") | Above the signature line |
| `doc_invoice_page_size` (A4), `doc_receipt_page_size` (A5) | Puppeteer paper format |
| `doc_show_logo`, `doc_show_gstin`, `doc_show_terms`, `doc_show_signature` | Toggles |

**Owner notifications:**
| Column | Use |
|---|---|
| `owner_phone` | WhatsApp recipient for owner alerts |
| `owner_notify_enabled` | Master toggle |

**Wi-Fi (used in check-in WhatsApp template):**
| Column | Use |
|---|---|
| `wifi_ssid` | Network name |
| `wifi_password` | Plaintext (yes — WhatsApp template needs it) |

### `room_types`

Reusable room categories (e.g. "AC Single Bed Rooms", "Non AC Single Bed Rooms"). Each type defines defaults that `rooms` inherit.

| Column | Use |
|---|---|
| `slug` unique | Identifier (`ac_single_bed_rooms`) |
| `label` | Display ("Ac Single Bed Rooms") |
| `default_rate` | Base price per night |
| `max_occupancy` | Default 2 |
| `description` | Free text |
| `is_active` | Archive flag |

### `rooms`

Individual rentable units.

| Column | Use |
|---|---|
| `room_number` unique | "101", "202" |
| `floor` | Integer |
| `room_type` | Slug FK → `room_types` |
| `base_rate` | Default rate |
| `max_occupancy` | Capacity |
| `status` | One of available / occupied / reserved / dirty / maintenance |
| `created_at`, `updated_at` | Audit |

**Status meaning** (the multi-step clean→inspected workflow was collapsed in migration 0034 to a single `dirty → available` step):
- `available` — bookable, no live reservation
- `reserved` — has a `confirmed` reservation overlapping today
- `occupied` — has a `checked_in` reservation
- `dirty` — guest just checked out; needs housekeeping → cleaned → back to `available`
- `maintenance` — out of service

These statuses are stored physically on the `rooms` row. The dashboard **derives** an effective status (occupied/reserved from live reservations) on top — see "Effective room status" in Business Rules. Note: deleting reservations does NOT auto-reset a room's physical status, so a bulk DB wipe can leave "ghost" reserved rooms that need resetting to `available`.

### `guests`

Personal data + KYC. ID numbers are **encrypted at rest**.

| Column | Use |
|---|---|
| `full_name`, `phone`, `email` | Contact |
| `id_proof_type` | aadhaar / pan / passport / driving_license / voter_id |
| `id_proof_number_encrypted` | AES-256-GCM ciphertext |
| `id_proof_last4` | Plaintext last 4 chars (for display, search) |
| `address`, `city`, `state`, `nationality` | Optional |
| `date_of_birth`, `company_name`, `gstin` | Optional |
| `notes`, `tags` (text[]) | Free-form per guest |
| `id_proof_photo_front`, `id_proof_photo_back` | Storage paths in `kyc-docs` bucket |
| `kyc_verified_at`, `kyc_verified_by` | Set when staff confirms ID |
| `created_at`, `updated_at` | Audit |
| Unique on `phone` | Same person, same hotel = same record |

**Encryption flow:** `lib/crypto.ts` provides `encrypt(plain)` and `decrypt(cipher)` using `ENCRYPTION_KEY` env. Encryption is for the ID number only — name/address/phone are stored in plain.

### `guest_notes` and `guest_follow_ups`

Per-guest notes and to-do items. Used in CRM-style pipelines (re-engagement, special requests). Lightweight — staff can add freely.

### `reservations`

The central booking entity. One row per stay.

| Column | Use |
|---|---|
| `reservation_number` unique | `SLDT-RES-NNNN` (also old `RES-YYYYMMDD-NNNN` for legacy rows) |
| `guest_id` FK | The booking guest |
| `check_in_date`, `check_out_date` | Half-open `[in, out)` — `daterange(in, out, '[)')` |
| `num_adults`, `num_children` | Headcount |
| `rate_per_night` | Snapshot of agreed rate (per the first/primary room) |
| `num_nights` | **Generated column**: `check_out_date - check_in_date` |
| `subtotal` | rate × nights × rooms (pre-GST) |
| `gst_rate`, `gst_amount` | Snapshotted from settings slab at booking creation |
| `grand_total` | subtotal + gst_amount |
| `advance_paid` | Sum of advance payments (excluding pending/unpaid) |
| `balance_due` | grand_total − advance_paid |
| `status` | confirmed → checked_in → checked_out (or cancelled / no_show) |
| `booking_source` | walkin / phone_whatsapp / complimentary |
| `credit_notes`, `cancellation_reason`, `special_requests` | Free text |
| `checked_in_at`, `checked_in_by` | Set on check-in |
| `checked_out_at`, `checked_out_by` | Set on check-out |
| `created_by`, `created_at`, `updated_at` | Audit |

**Constraint:** `CHECK (check_out_date > check_in_date)` — no zero-night stays.

### `reservation_rooms`

Many-to-many between reservations and rooms. A reservation can hold multiple rooms.

| Column | Use |
|---|---|
| `reservation_id` FK (cascade) | |
| `room_id` FK | |
| `rate_per_night` | Per-room snapshot (rates can differ between rooms in the same booking) |
| `sold_as_type` | If a room is being sold under a different type label (rare) |

### `invoices`

Generated atomically at check-out.

| Column | Use |
|---|---|
| `invoice_number` unique | `SLDT-INV-NNNN` |
| `reservation_id` FK | |
| `guest_id` FK | |
| Hotel snapshot (name, address, GSTIN) | Fixed at issue time so historical invoices stay accurate |
| Guest snapshot (name, address, GSTIN) | Same reason |
| `subtotal` | Pre-GST sum of all line items |
| `cgst_rate`, `cgst_amount` | Half of room GST |
| `sgst_rate`, `sgst_amount` | Other half |
| `grand_total` | Final billable |
| `total_paid` | Sum of `received` payments (excluding pending) |
| `balance_due` | grand_total − total_paid |
| `status` | issued / partial / paid / voided |
| `scope` | `combined` (whole stay — the default) / `room` (one room) / `partial` |
| `scope_room_ids` | uuid[] of rooms this invoice covers |
| `document_type` | `invoice` or `credit_note` (migration 0042) |
| `credit_note_for` | self-FK → the invoice a credit note reverses (NULL on ordinary invoices) |
| `wallet_credit_applied` | Wallet credit redeemed against this invoice |
| `voided_reason`, `voided_by`, `voided_at` | Audit on void |
| `issued_by`, `created_at`, `updated_at` | Audit |

**Credit notes** share this table: `document_type='credit_note'`, negative money columns, `credit_note_for` pointing at the reversed invoice. They never hold payments and are excluded from the orphan-payment redistribution logic. Numbered `SLDT-CN-NNNN`.

### `invoice_line_items`

| Column | Use |
|---|---|
| `invoice_id` FK | |
| `description` | "Room 101 - ac_single_bed_rooms (1 nights)" or charge name |
| `sac_code` | Defaults to `9963` (lodging services SAC) |
| `quantity`, `rate`, `amount` | Standard money fields |
| `gst_rate`, `gst_amount` | Per-line GST |
| `item_type` | `room_charge` or `additional_charge` |

### `payments`

Both advances (during stay) and finals (at checkout). Includes pending/unpaid concept.

| Column | Use |
|---|---|
| `receipt_number` unique | `SLDT-RCP-NNNN` |
| `invoice_id` (nullable) | Linked once invoice is generated; before checkout it's null |
| `reservation_id` FK | Always set |
| `amount` | Money received (or promised, if pending) |
| `payment_method` | cash / upi / card / bank_transfer / **unpaid** |
| `status` | **`received`** (default) or **`pending`** — the unpaid concept |
| `payment_date` | Defaults to now |
| `received_by` | Staff member |
| `notes` | Reason / reference / cheque number |
| `voided`, `voided_reason`, `voided_by`, `voided_at` | Soft-delete with audit |

**`amount > 0` constraint** at the DB level.

**Pending payment lifecycle:**
1. At check-out, staff picks "Unpaid · Collect later" + writes a reason.
2. Row inserted with `payment_method=unpaid`, `status=pending`, full amount.
3. Invoice's `total_paid` does **not** include this row, so `balance_due` reflects the still-owed amount.
4. Later, owner clicks **Mark Received** → row updates to `payment_method=cash` (or whatever), `status=received`.
5. Invoice `total_paid` and `balance_due` recompute, status flips to `paid`.

### `additional_charges`

Per-reservation extras (e.g., laundry, mini-bar, late checkout). Charged at checkout as line items.

| Column | Use |
|---|---|
| `reservation_id` FK | |
| `description`, `quantity`, `rate`, `amount` | Standard |
| `gst_rate` | Defaults to settings.additional_charge_default_gst |
| `added_by`, `created_at` | Audit |

### `activity_log`

Append-only audit trail. Every meaningful action writes here.

| Column | Use |
|---|---|
| `action` | snake_case verb (`reservation_created`, `check_in`, `payment_marked_received`, etc.) |
| `entity_type`, `entity_id` | Polymorphic reference |
| `description` | Human-readable summary |
| `performed_by` FK → profiles | Who |
| `ip_address` | From `req.ip` (best-effort) |
| `metadata` jsonb | Anything contextual |
| `created_at` | When |

Used by `Activity.tsx` page; never mutated, never deleted.

### `notifications`

In-app dashboard notifications (the bell + Notifications page).

| Column | Use |
|---|---|
| `recipient_id` FK → profiles | One row per recipient |
| `type` | reservation_created / guest_checked_in / guest_checked_out / message_received / etc. |
| `title`, `body`, `href` | Rendering payload |
| `payload` jsonb | Free-form |
| `read_at` | Null until clicked / mark-all-read |
| `created_at` | When |

Indexes for fast unread queries: `(recipient_id, read_at)` and `(recipient_id, created_at)`.

### `messages`

Staff-to-staff chat (used between front-desk and housekeeping).

| Column | Use |
|---|---|
| `sender_id`, `recipient_id` FK → profiles | |
| `body` | text |
| `read_at` | When recipient opened the thread |
| `created_at` | When |

The Messages page in the web app uses raw SQL (`db.execute`) for the threads-summary query.

### `otps`

One-time passwords for guest verification at check-in.

| Column | Use |
|---|---|
| `purpose` | `checkin` or `guest_verify` |
| `channel` | `sms` (WhatsApp) or `email` (currently unused) |
| `target` | Phone number or email |
| `code_hash` | SHA-256 of code + JWT secret (so even DB dump doesn't expose codes) |
| `reservation_id`, `guest_id` | Optional FKs |
| `expires_at` | Default 5 min from creation |
| `attempts` | Increment on wrong code; capped via `OTP_MAX_ATTEMPTS` |
| `consumed_at` | Set on successful verify; OTP becomes single-use |

**Rate limit**: One OTP per target per minute (enforced in `routes/otp.ts` via `gt(createdAt, now() - interval '1 minute')`).

### `message_templates`

Editable WhatsApp message bodies. Five active keys:

| Key | When |
|---|---|
| `checkin_guest_sms` | After successful check-in |
| `checkin_owner_sms` | Same moment, to owner phone |
| `checkout_guest_sms` | After successful check-out (includes invoice PDF link) |
| `checkout_owner_sms` | Same moment, to owner phone |
| `otp_guest_sms` | When staff initiates check-in OTP |
| `payment_reminder_guest_sms` | Manual button on Collections page |

| Column | Use |
|---|---|
| `key` unique | One of the keys above |
| `subject` | Email subject (currently unused — email is disabled) |
| `body` | Template string with `{placeholders}` |
| `enabled` | Disable to skip sending without losing the wording |
| `created_at`, `updated_at` | Audit |

**How rendering works:** `lib/templates.ts` exports `renderTemplate(key, vars)`. It loads the row from DB (60s in-memory cache), falls back to a hardcoded default if no row exists, replaces every `{name}` with `vars.name`. Empty/null vars become empty strings.

---

## API surface

Every route is mounted at `/api/v1/*`. Auth is required everywhere except `/health`.

### `auth.ts`

| Route | Method | Purpose |
|---|---|---|
| `/auth/login` | POST | Frontend doesn't actually use this — it goes direct to Supabase. Kept for completeness. |
| `/auth/logout` | POST | No-op success (Supabase handles the actual logout client-side). |
| `/auth/me` | GET | Returns the authenticated user's profile. Called by AuthContext on app load. |

### `dashboard.ts`

| Route | Method | Purpose |
|---|---|---|
| `/dashboard` | GET | Aggregates: occupancy %, today's check-ins, today's check-outs, today's revenue, room grid (with effective status + linked reservation per room), recent activity. Cached in Redis 30s. |

### `rooms.ts`

| Route | Method | Purpose |
|---|---|---|
| `/rooms` | GET | List with filters |
| `/rooms` | POST | Admin only. Returns 409 on duplicate room number. |
| `/rooms/:id` | GET, PATCH | Get / update |
| `/rooms/:id` | DELETE | Admin only |
| `/rooms/availability?check_in=&check_out=` | GET | Returns rooms that are not in maintenance and have no overlapping `confirmed`/`checked_in` reservation in the date range |

### `reservations.ts`

The biggest route file. Handles the entire stay lifecycle.

| Route | Method | Purpose |
|---|---|---|
| `/reservations` | GET | List with status/date filters, pagination |
| `/reservations` | POST | Create. Validates GST slab, generates `SLDT-RES-NNNN`, blocks rooms (status=reserved), records advance payment if any. Fires in-app notification only — WhatsApp is NOT sent at booking. |
| `/reservations/:id` | GET | Full detail with guest, rooms, charges, invoice, payments |
| `/reservations/:id/check-in` | POST | Requires KYC verified + ID photo on file. Flips status to `checked_in`, rooms to `occupied`, can take advance. Fires WhatsApp to guest + owner. |
| `/reservations/:id/check-out` | POST | Generates `SLDT-INV-NNNN`, computes line items + GST split, requires final payment (or "unpaid" with notes), rooms → dirty. Fires WhatsApp with invoice PDF link. |
| `/reservations/:id/cancel` | POST | Only for `confirmed` or `checked_in`. Frees rooms. |
| `/reservations/:id/charges` | POST | Add additional charge |
| `/reservations/:id/charges/:chargeId` | PATCH, DELETE | Edit / remove a charge |
| `/reservations/:id/edit-dates` | POST | Re-check availability for new dates |
| `/reservations/:id/swap-room` | POST | Move guest to a different room |
| `/reservations/:id/extend` | POST | Extend by N nights |
| `/reservations/:id/late-checkout` | POST | Charge late-checkout fee as an additional charge |
| `/reservations/:id/add-room` | POST | Add a room mid-stay |
| `/reservations/:id/rooms/:roomId` | PATCH | Edit per-room rate |
| `/reservations/:id/rooms/:roomId/check-out` | POST | Per-room checkout. Issues that room's invoice; at the FINAL room, auto-consolidates fully-paid per-room invoices into one combined invoice. |
| `/reservations/:id/rooms/:roomId/checkout-quote` | GET | Pre-checkout bill for one room (equal advance share) |
| `/reservations/:id/extend-options` | GET | Which rooms are free for an extension window + free alternative rooms |
| `/reservations/:id/extend-continue` | POST | OTP-verified continuation booking for the same guest in a different room |
| `/reservations/:id/make-complimentary` | POST | Reclassify as complimentary (silences it everywhere; deletes its existing notifications) |
| `/reservations/:id/no-show` | POST | Mark a confirmed booking no-show (advance forfeit) |
| `/reservations/:id/apply-wallet-credit` | POST | Redeem guest wallet credit against the reservation |
| `/reservations/:id/convert-invoices` | POST | (Legacy — reshape per-room ↔ combined. No longer surfaced in UI.) |

### `invoices.ts`

| Route | Method | Purpose |
|---|---|---|
| `/invoices` | GET | List with status/date/scope/search filters. Excludes comp-reservation invoices. Date filters are IST-day bounds. |
| `/invoices/summary` | GET | Money rollup (gross/paid/owing) for the filtered set |
| `/invoices/export` | GET | Flat CSV of every matching invoice (CA-grade detail) |
| `/invoices/:id` | GET | Full invoice with line items + payments |
| `/invoices/:id/pdf` | GET | Renders Puppeteer PDF (invoice or credit-note variant), `application/pdf`. Resolver accepts `SLDT-INV-` and `SLDT-CN-` numbers. |
| `/invoices/:id/room-bill-options` | GET | Which rooms a combined invoice can be split into (for the per-room bill buttons) |
| `/invoices/:id/room-bill/:roomNumber/pdf` | GET | **Presentation-only** per-room bill PDF — one room's slice of the combined invoice. No DB row, no GST, no money. |
| `/invoices/:id` | PATCH | Edit (admin only, locked once paid) |
| `/invoices/:id/void` | POST | Admin only. Sets status=voided. |

> The old `/invoices/:id/reissue` and the reservation-level `convert-invoices` "reshape per-room ↔ combined" flow are no longer surfaced in the UI (convert-invoices endpoint still exists but is unused). Reshaping is obsolete: there's one combined invoice, and per-room is just a printable view of it.

### `payments.ts`

| Route | Method | Purpose |
|---|---|---|
| `/payments` | POST | Standalone payment record (e.g., guest pays mid-stay against a partial invoice) |
| `/payments/:id/receipt` | GET | Download Puppeteer-rendered receipt PDF |
| `/payments/:id` | PATCH | Edit method/notes (admin, within 24h) |
| `/payments/:id/void` | POST | Admin. Recomputes invoice totals. |
| `/payments/:id/mark-received` | POST | Flips a `pending` payment → `received`. Updates invoice + reservation balances. |

### `housekeeping.ts`

| Route | Method | Purpose |
|---|---|---|
| `/housekeeping` | GET | All rooms with status |
| `/housekeeping/:roomId` | PATCH | Change status. Validates the transition (e.g., dirty→clean is allowed; occupied→clean is not). |
| `/housekeeping/:roomId/maintenance` | POST | Flag for maintenance with a reason |
| `/housekeeping/:roomId/resolve` | POST | Resolve a maintenance flag (admin only) |

**Allowed transitions** (from `routes/housekeeping.ts`; the multi-hop clean/inspected ladder was collapsed in migration 0034):
- `dirty` → `available`, `maintenance`
- `available` → `dirty`, `maintenance`
- `maintenance` → `available`, `dirty`
- `occupied` / `reserved` → no transitions (those are reservation-driven)

### `guests.ts`

| Route | Method | Purpose |
|---|---|---|
| `/guests` | GET | Search/list with phone/name fuzzy match |
| `/guests` | POST | Create. Encrypts ID number. Rejects duplicate phone. |
| `/guests/:id` | GET, PATCH | Get/update |
| `/guests/:id/kyc` | POST (multipart) | Upload front + back ID photos to private Supabase Storage `kyc-docs` bucket |
| `/guests/:id/kyc/sign?path=` | GET | 5-minute signed URL for viewing a KYC photo |
| `/guests/:id/notes` | GET, POST | List / add notes |
| `/guests/:id/follow-ups` | GET, POST | List / add tasks |
| `/guests/:id/follow-ups/:fid` | PATCH | Mark done / cancelled |

### `notifications.ts`

| Route | Method | Purpose |
|---|---|---|
| `/notifications` | GET | List for the current user with `unreadCount`. `?unreadOnly=true&limit=N` |
| `/notifications/:id/read` | POST | Mark one read |
| `/notifications/read-all` | POST | Bulk |

### `messages.ts`

| Route | Method | Purpose |
|---|---|---|
| `/messages/staff` | GET | List of all staff (for "compose new" pickers) |
| `/messages/threads` | GET | Conversation summaries (per other-user, last message, unread count) — uses raw SQL CTE |
| `/messages?with=<userId>` | GET | Full thread between current user and `with`. Marks incoming as read. |
| `/messages` | POST | Send a message. Fires in-app notification to recipient. |

### `otp.ts`

| Route | Method | Purpose |
|---|---|---|
| `/otp/send` | POST | `{ reservationId, channel }` — generates code, hashes, inserts row, sends via WhatsApp template. Returns dev code in response when `NOTIFICATIONS_PROVIDER=stub`. |
| `/otp/verify` | POST | `{ reservationId, code }` — checks the latest active OTP for that reservation, increments attempts on miss, marks consumed on hit |

### `reports.ts` (admin only)

| Route | Method | Purpose |
|---|---|---|
| `/reports/occupancy` | GET | Daily occupied-room count over a date range |
| `/reports/daily-ledger` | GET | Day book: per-day rooms occupied (+ guest, nightly price), collected, expenses, net |
| `/reports/revenue` | GET | Daily collected revenue (payments grouped by IST day) |
| `/reports/collections` | GET | Daily collection breakdown |
| `/reports/gst-summary` | GET | CGST/SGST totals by status, with a **credit-notes** line that nets out reversed tax |
| `/reports/outstanding` | GET | Returns: list of unpaid invoices, list of pending payments, by-guest aggregate, total outstanding |
| `/reports/outstanding/remind/:guestId` | POST | Sends `payment_reminder_guest_sms` WhatsApp to the guest |
| `/reports/room-performance` | GET | Per-room nights occupied + revenue |
| `/reports/credit-bookings` | GET | Complimentary stays in the date range |
| `/reports/guests` | GET | Top guests by frequency / spend |

### `settings.ts`

Settings + Staff + Templates all live here.

| Route | Method | Purpose |
|---|---|---|
| `/settings` | GET, PUT | Full settings (admin only) |
| `/settings/public` | GET | Subset visible to all authed users — name, address, phone, GSTIN, logo, check-in/out times |
| `/settings/room-types` | GET, POST | List + create |
| `/settings/room-types/:id` | PUT, DELETE | Edit / archive |
| `/settings/templates` | GET | List all message templates with metadata + defaults |
| `/settings/templates/:key` | PUT | Update body / subject / enabled |
| `/settings/templates/:key/reset` | POST | Reset to hardcoded default |
| `/staff` | GET, POST | List + create staff (creates Supabase Auth user atomically) |
| `/staff/:id` | PUT, DELETE | Update / soft-delete |
| `/staff/:id/hard` | DELETE | Hard delete (refuses if user has historical references) |

---

## Web app

### Provider tree (`main.tsx`)

```
<BrowserRouter>
  <QueryClientProvider>          # TanStack Query, 30s stale, no refetch-on-focus
    <AuthProvider>               # Supabase session + profile
      <ToastProvider>            # Bottom-right toaster
        <App />
```

### Routes (`App.tsx`)

Each protected route is wrapped in `<ProtectedRoute>` (redirects to /login if no session) and `<AppShell>` (sidebar + main pane). Some are also wrapped in `<RoleGuard>` to filter by role.

| Path | Roles | Page |
|---|---|---|
| `/login` | public | Login.tsx |
| `/` | admin, frontdesk | Dashboard |
| `/rooms` | admin, frontdesk | Rooms |
| `/rooms/:id` | admin | RoomDetail |
| `/reservations` | admin, frontdesk | Reservations |
| `/reservations/new` | admin, frontdesk | NewReservation |
| `/reservations/:id` | admin, frontdesk | ReservationDetail |
| `/guests` | admin, frontdesk | Guests |
| `/guests/:id` | admin, frontdesk | GuestProfile |
| `/housekeeping` | all | Housekeeping |
| `/messages` | all | Messages |
| `/notifications` | all | Notifications |
| `/collections` | admin | Collections |
| `/activity` | admin, frontdesk | Activity |
| `/reports` | admin | Reports |
| `/settings` | admin | Settings |

### Pages — what each does

#### `Dashboard.tsx`

**Above the fold:** four stat cards (occupancy %, today's check-ins, today's check-outs, revenue today) and two action buttons (Pre-booking / Walk-in).

**Availability by Room Type:** one card per room type. Each shows:
- Total count + available count + percent
- Multi-segment progress bar (each status colored)
- Status chips that only render when count > 0 (Available, Occupied, Reserved, Dirty, Clean, Inspected, Maintenance)
- Room tiles with the room number + status label. Click behavior:
  - Available → walk-in flow with room pre-selected
  - Occupied/Reserved → reservation detail
  - Dirty/Clean/Inspected/Maintenance → opens a popover with valid status transitions

**Below:** today's check-ins and check-outs lists.

#### `NewReservation.tsx`

Used for both pre-bookings and walk-ins. URL `?mode=walkin` or `?mode=booking` (default).

**Sections (top to bottom):**
1. **Stay Details** — dates, headcount, purpose, special requests
2. **Guest** — search existing or create new (with KYC fields)
3. **KYC Documents** — file picker with image preview. Required for walk-in.
4. **Rooms** — selectable cards filtered by AC/non-AC. Each room shows base rate, can be re-rated, can be sold-as a different type
5. **Booking Source** — Walk-in / Phone-WhatsApp / Complimentary
6. **OTP toggle** — defaults on for pre-booking, off for walk-in. When on, an OTP modal interrupts before the receipt opens.
7. **Advance Payment** — amount + method
8. **Subtotal preview**

**Submit behavior:**
- Pre-booking → creates reservation, fires in-app notification, navigates to detail
- Walk-in → creates reservation + auto-checks-in + fetches detail + opens **Check-in Receipt** overlay

#### `ReservationDetail.tsx`

The control center for a single reservation. Tabs are conditional on status.

**Always shown:**
- Header card with reservation number + status pill
- Guest, Dates, Balance summary cards
- KYC verified line with View/Replace
- Action bar: Verify & Check In / Check Out & Generate Invoice / Add Charge / Extend / Add Room / Edit Dates / Late Checkout / Record Payment / Cancel
- Rooms table (with per-room status popover)

**Conditional:**
- Additional Charges table (if any)
- Invoice card (post-checkout)
- Payment History (rows with Mark Received / Print / Edit / Void buttons)

**Modals:** ChargeModal, PaymentModal, CheckoutModal, KycModal, OtpModal, CheckInReceiptModal, ExtendModal, LateCheckoutModal, AddRoomModal, EditDatesModal — each is a separate component file or inline.

#### `Collections.tsx` (admin only)

Money-due-from-guests view. Sections:
- 4 stat cards: Total Outstanding, 0–7 days, 8–30 days, 30+ days (each shows ₹ + guest count)
- **By Guest** table — sorted oldest first, with Call (`tel:` link) + WhatsApp Remind buttons per row
- **Pending Payments** table — pending status payments with reason, Mark Received button per row
- **All Unpaid Invoices** — full list

#### `Settings.tsx` (admin only)

Tabbed: Hotel Profile / Invoice & Receipt / Messages / Room Types / Staff.

- **Hotel Profile** — basic info, GST slabs, Owner Notifications section, Guest Wi-Fi section
- **Invoice & Receipt** — color pickers, page sizes, footer/terms text, toggles, **live preview** pane
- **Messages** — 5 cards (one per active template). Each: enable/disable toggle, subject (email only — email is disabled, only `payment_reminder` for now since no email templates exist), body textarea, **clickable variable chips** (insert at cursor), Reset to Default, Save
- **Room Types** — CRUD
- **Staff** — list with Add Staff. Edit modal lets admin change name / role / email / phone, reset password (with strong-password generator), and bottom-right Delete button (hard delete with safety checks)

#### `Reports.tsx` (admin only)

Tabbed: Occupancy / Revenue / Collections / GST / Outstanding / Rooms / Guests / Complimentary. Each tab has a date-range picker (defaults to current month) and an Export-to-CSV button.

#### Other notable pages

- **Notifications.tsx** — full-width list with All/Unread filters, day groups, type icons, click-to-navigate
- **Messages.tsx** — staff chat. Two-column: thread list + conversation pane
- **Login.tsx** — split layout with brand panel + form. Eye toggle, Caps Lock detection, "Remember my email" via localStorage
- **GuestProfile.tsx** — header with Outstanding badge if guest owes money; tabs: Profile / Notes / Follow-ups
- **Activity.tsx** — chronological audit log
- **Housekeeping.tsx** — kanban-like board grouped by status

### Key reusable components

| Component | Use |
|---|---|
| `AppShell` | Sidebar + main pane wrapper. Pre-fetches `/settings/public` so receipt overlays open instantly. Listens for new notifications and fires toasts. |
| `Sidebar` | Fixed left nav. Reads `profile.role` to filter items. Notifications has dot indicator; Collections has pulsing red dot when balance > 0. |
| `Loader` | Logo-centered loader (white circle + brand-jade rotating arc). Sizes sm/md/lg. Optional fullscreen overlay. |
| `OtpModal` | Two-step: pick channel → verify. Shows dev code in stub mode. Caps lock warning, expiry timer. |
| `CheckInReceiptModal` | Print-ready overlay. CSS `@media print` rules pull only this card to one A4 page. Used after both walk-in submit and existing-reservation check-in. |
| `RoomActionPopover` | Per-room status menu with all valid forward + reverse transitions. Optimistic update via TanStack Query cache. |
| `KycModal` | Replace ID photos for an existing guest |
| `Toast` (provider) | Bottom-right toaster + `useNotificationToasts(unreadIds)` for notification ping toasts |
| `NotificationBell` | Header bell with dropdown — currently NOT mounted anywhere (we removed it from AppShell; the sidebar Notifications item handles this now) |
| `StatusBadge` | Small reservation-status pill |

---

## Business rules and core flows

### Walk-in flow (most common case)

1. Front desk clicks **Walk-in** on dashboard → `/reservations/new?mode=walkin`
2. Form auto-sets check-in to today, check-out to tomorrow
3. Staff types guest's phone in the search box → if found, picks the existing guest (KYC may already be on file); if not, switches to "New Guest" tab and fills KYC
4. **Uploads ID photo (front) — required**. Optionally back side too.
5. Selects a room — only available rooms appear (the API filters by overlap)
6. Booking source defaults to "Walk-in"
7. (Optionally) Records advance payment
8. Clicks **Check In Now** → POST `/reservations` (creates) → POST `/reservations/:id/check-in` (auto-checks-in)
9. Frontend re-fetches the reservation + settings → opens `<CheckInReceiptModal>` with full details
10. Staff hits **Print** → prints the slip → hands to guest
11. WhatsApp `checkin_guest_sms` and `checkin_owner_sms` fire in the background

### Pre-booking flow (phoned in)

1. Front desk clicks **Pre-booking** → same form, default `?mode=booking`
2. Future dates allowed
3. KYC optional at booking; will be enforced at check-in
4. OTP toggle defaults ON — when staff submits, OTP modal interrupts → guest reads the code → submit succeeds
5. Reservation created (no check-in yet), advance recorded if any
6. **No WhatsApp fires at this stage** — the guest hasn't arrived. Only an in-app notification.
7. Later, when the guest arrives, staff opens the reservation → clicks **Verify & Check In** → OTP modal → check-in API → receipt overlay → WhatsApp fires

### Check-out flow

1. Open the (checked-in) reservation
2. Click **Check Out & Generate Invoice**
3. Modal shows balance owed
4. Staff types the **final payment amount** (defaults to the balance) and picks method
5. **Special: "Unpaid · Collect later"** — invoice is generated as unpaid, payment row stored with `status=pending`. Notes are required.
6. Submit → `POST /reservations/:id/check-out`
   - Server snapshots line items (each room × nights with GST) onto **ONE combined invoice** (the default)
   - Generates `SLDT-INV-NNNN`
   - Inserts payment with `status=received` (or `pending` if unpaid)
   - Updates reservation to `checked_out`
   - Updates rooms to `dirty`
   - (Per-room checkout is a separate flow — `POST /reservations/:id/rooms/:roomId/check-out` — that bills each room, then auto-consolidates the fully-paid per-room invoices into one combined invoice when the last room leaves.)
7. **Async** (in `void IIFE` so it doesn't block the response):
   - Renders invoice PDF via Puppeteer
   - Uploads to public Supabase Storage `documents/invoices/SLDT-INV-NNNN.pdf`
   - Renders the `checkout_guest_sms` template with `{invoice_link}` filled
   - Sends WhatsApp to guest + owner
8. Frontend invalidates the reservation query → status flips to **Checked Out** with the new invoice card visible

### Effective room status (dashboard logic)

A room's "real" status is **derived** at query time, not stored. The dashboard's room_grid does:

```
if room has a checked_in reservation today  → "occupied"
elif room has a confirmed reservation today → "reserved"
else                                        → rooms.status from DB (available/dirty/clean/etc.)
```

This means the housekeeping status (`dirty`/`clean`/`inspected`/`maintenance`) only "shows through" when there's no active stay. While a guest is in the room, the dashboard says **occupied** regardless of `rooms.status`.

The room grid response also carries `reservation_id` and `guest_name` — used for click-to-open behavior and tooltips.

### Optimistic updates (UI snappiness)

Three places use TanStack Query's `onMutate` to flip the UI immediately and reconcile with the server in the background:

1. **Room status popover** (`RoomActionPopover`) — the tile's status changes the moment you click "Mark Clean", before the API responds. If the API rejects, the change rolls back via the snapshotted old state.
2. **Check-in mutation** — the reservation status badge changes to "Checked In" instantly; the receipt modal opens; server confirms in the background.
3. **Notifications** — bell dropdown updates without waiting.

All optimistic updates have `onError` rollback handlers so partial failures don't leave the UI lying.

### Pre-cached settings

`AppShell` does a `useQuery({ queryKey: ["settings-public"], staleTime: 30min })` on mount. This means by the time the user opens a check-in receipt, the hotel's name/logo/phone are already cached — the receipt opens instantly with no spinner.

### Date semantics

- **Check-in/check-out dates** are stored as `date` (no time). The hotel's check-in time (12:00) and check-out time (11:00) are policy values displayed on receipts but not enforced.
- **Date range overlap** is computed in Postgres via `daterange(in, out, '[)')` — half-open. This means same-day-checkout-and-checkin is allowed.
- All other timestamps (created_at, etc.) are `timestamptz` in UTC.

### Money handling

- All amounts stored as `numeric(10, 2)` strings.
- All math done on `Number(x)` and rounded with `+x.toFixed(2)`.
- **Always recompute on the server** — never trust client-supplied totals.
- Currency symbol comes from settings; defaults to ₹.

---

## Notifications and messaging

### Channels

- **WhatsApp via Twilio** — primary. Uses Twilio's WhatsApp Business API.
- **In-app notifications** — instant, dashboard bell + Notifications page.
- **Email** — disabled. The `messaging.sendEmail()` returns `{ ok: true, provider: "disabled" }` without doing anything. Templates and `notifyGuestEmail()` calls are still in the code but no-op safely.

### Provider modes

`NOTIFICATIONS_PROVIDER` env var:
- `stub` — logs messages to API console as `[WHATSAPP STUB] to: +91... text: ...`. Returns success. Useful for dev/test without burning Twilio credit.
- `live` — actually calls Twilio's REST API.

### How a WhatsApp gets sent

`apps/api/src/lib/messaging.ts:sendWhatsAppLive` does:
1. Normalize the phone number (`9876543210` → `+919876543210`)
2. Prefix with `whatsapp:` (e.g., `whatsapp:+919876543210`)
3. POST to `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json`
4. Use HTTP Basic auth with `SID:token`
5. Body: `application/x-www-form-urlencoded` with `To`, `Body`, and either `From` or `MessagingServiceSid`

### Twilio sandbox vs production

- **Sandbox** (`+14155238886`): Recipients must "join" once by sending a code-word like `join brave-tiger` to that number from their WhatsApp. Free; works only with joined numbers.
- **Production**: Apply for a WhatsApp Business sender via Twilio Console. Requires Meta business verification (2–7 days). Once approved, replace `TWILIO_WHATSAPP_FROM` with the new number.

### Active WhatsApp triggers

| Event | Recipient | Template key |
|---|---|---|
| Check-in | guest + owner | `checkin_guest_sms`, `checkin_owner_sms` |
| Check-out | guest + owner | `checkout_guest_sms`, `checkout_owner_sms` |
| OTP request | guest | `otp_guest_sms` |
| Manual reminder (Collections page) | guest | `payment_reminder_guest_sms` |

**No WhatsApp on:** booking creation, payment received, guest-edit, room-status change, etc. Those fire only in-app notifications.

### Owner notifications

`lib/notify.ts:notifyOwner(text)`:
- Loads settings
- If `ownerPhone` is empty or `ownerNotifyEnabled = false` → no-op
- Otherwise calls `messaging.sendSms()` (which is now WhatsApp under the hood)

### In-app notifications

`lib/notify.ts:dispatchNotification({ type, title, body, href, recipientRoles, recipientIds })`:
- Resolves recipients (by role list or by id list)
- Inserts one row per recipient into `notifications` table
- The bell + Notifications page poll `GET /notifications` every 15–30s

---

## PDF documents

All PDFs are server-side via Puppeteer (`apps/api/src/lib/pdf.ts`).

### Architecture

- One headless Chromium instance per Node process, lazy-launched
- Each render: open new page → set HTML → call `page.pdf({ format, margin })` → close page
- HTML is a single-file template with inline CSS using `commonStyles(L)` shared between invoice + receipt
- Layout reads from settings (`docPrimaryColor`, `docAccentColor`, page size, etc.)
- Logo is fetched as a remote URL by Chromium (so it must be a public URL, hence the public Supabase Storage bucket)

### Documents rendered

| Doc | Function | Page size (default) | When |
|---|---|---|---|
| Invoice | `renderInvoicePdf` | A4 | At check-out (auto-uploaded to public bucket; downloadable from reservation page) |
| Credit note | `renderInvoicePdf` (same renderer; `documentType='credit_note'` retitles to "CREDIT NOTE", shows the reversed invoice ref, negative amounts) | A4 | When a paid invoice is reversed |
| Room bill | `renderInvoicePdf` with the `roomBill` option | A4 | On demand — a presentation-only per-room slice of a combined invoice. Titled "ROOM BILL", references the parent invoice number, banner says it's not a separate tax invoice. |
| Payment Receipt | `renderReceiptPdf` | A5 | At advance payment + each subsequent payment; downloadable from payment row |
| Check-in slip | (HTML rendered in `CheckInReceiptModal.tsx` and printed via browser CSS, NOT Puppeteer) | A4 | Right after check-in |

Invoice + receipt PDFs list **each payment individually** in the totals block (e.g. "Paid · Advance at booking ₹1,000", "Paid · Collected at check-out ₹500") via the shared `paidLinesHtml` helper, instead of an advance/later summary.

Why the check-in slip is browser-printed: it needs to print immediately at the front desk without a download step. The `@media print` CSS hides everything except the receipt card.

### Public storage for WhatsApp links

`lib/storage.ts:uploadPublicPdf(path, buffer)`:
- Lazy-creates the `documents` bucket as **public** on first call
- Uploads with `upsert: true`
- Returns the public URL like `https://wujndnaasfyzxpmaatcj.supabase.co/storage/v1/object/public/documents/invoices/SLDT-INV-0001.pdf`

The returned URL is then injected as `{invoice_link}` into the WhatsApp template.

---

## GST and money handling

### India hotel GST slabs (current rules)

Encoded in settings (`gst_slab_*` columns) so they can change without code:

| Room rate | GST | Comment |
|---|---|---|
| < ₹1,000 | 0% | Exempt |
| ₹1,000 – ₹7,500 | 5% | Low slab |
| > ₹7,500 | 18% | High slab |

`lib/gst.ts:getGstRate(rate, settings)` returns the applicable rate.

### CGST/SGST split

Indian intra-state sales split GST evenly:
- CGST = SGST = (gst_amount / 2)
- Each rate = (gst_rate / 2)

For a ₹3,000 room with 18% GST: subtotal ₹3,000, CGST ₹270, SGST ₹270, total ₹3,540.

### Where rates snap

- **Reservation creation** — `gst_rate` is computed from the room's rate + slab and **frozen** on the reservation. If the room's rate changes mid-stay, the original rate stays.
- **Invoice generation** — line items inherit the snapped rate from reservation. CGST/SGST split is recomputed.

### Additional charges

Each charge has its own GST rate (default 18% from settings.additional_charge_default_gst). Applied per-line on the invoice.

---

## Document numbering

Old format (deprecated, kept for legacy rows): `RES-20260506-0001`, `INV-202605-0012`, `RCP-20260506-0014`.

**Current format:** `SLDT-RES-NNNN`, `SLDT-INV-NNNN`, `SLDT-RCP-NNNN`, `SLDT-CN-NNNN` (credit notes) — pure sequence, branded. Formatting helpers in `lib/numbers.ts` (`reservationNumber`, `invoiceNumber`, `receiptNumber`, `creditNoteNumber`).

### How the next sequence is computed

Numbers come from **real Postgres sequences** (atomic — `nextval`), not max+1 reads. Helpers in `lib/availability.ts`:
- `nextDailySequence()` → `sldt_reservation_seq`
- `nextInvoiceSequence()` → `sldt_invoice_seq`
- `nextReceiptSequence()` → `sldt_receipt_seq`
- `nextCreditNoteSequence()` → `sldt_credit_note_seq`

Because they're sequences, two concurrent checkouts can't collide. The sequences can be `ALTER SEQUENCE ... RESTART WITH 1` to renumber from scratch (e.g. after a DB reset for fresh testing).

### Why no fiscal-year reset

GST audit cleanliness is a preference, not a requirement. A continuous monotonic sequence is fine and avoids the "two `0001`s in different years" ambiguity for staff.

---

## Settings, templates, and customization

### What admins can change without code

| Thing | Where |
|---|---|
| Hotel name, address, phone, GSTIN, logo | Settings → Hotel Profile |
| GST slabs | Settings → Hotel Profile (advanced section) |
| Check-in / Check-out policy times | Settings → Hotel Profile |
| Owner phone + notification toggle | Settings → Hotel Profile |
| Guest Wi-Fi (used in check-in WhatsApp) | Settings → Hotel Profile |
| Invoice / receipt colors, page size, footer text, terms, signature label, toggles | Settings → Invoice & Receipt (with live preview) |
| Every WhatsApp template body | Settings → Messages (with `{var}` chip insertion + reset to default) |
| Room types (label, base rate, max occupancy) | Settings → Room Types |
| Staff users + passwords | Settings → Staff |

### Template variable system

Each template has a hardcoded list of available variables (see `lib/templates.ts:TEMPLATE_VARS`). The Settings UI shows them as clickable chips below the textarea.

`renderTemplate(key, vars)`:
1. Loads cached row from DB (60s in-memory cache)
2. Falls back to `TEMPLATE_DEFAULTS[key]` if no row
3. Replaces `{name}` with `vars.name`. Missing/null vars become empty strings.
4. Returns `{ enabled, subject?, body }`

Trigger code looks like:
```ts
const t = await renderTemplate("checkin_guest_sms", baseVars);
if (t.enabled) await notifyGuestSms({ to: g.phone, text: t.body });
```

So disabled templates skip cleanly; missing vars don't crash.

---

## Observability and ops

### Logging

- `lib/logger.ts` exports a pino instance configured via env. Pretty in dev, JSON in production.
- `pino-http` middleware logs every request with response time + status.
- `logActivity(...)` writes domain events to the `activity_log` table (visible in `/activity`).

### Health endpoint

`GET /health` → `{ status: "ok", time: <iso> }`. Used by uptime monitors. No auth.

### Rate limits

`middleware/rateLimit.ts`:
- `loginLimiter` — applied only to `/auth/login`. Strict (5 attempts per 15 min by IP).
- `readLimiter` — all GETs. Generous (100/min per IP).
- `writeLimiter` — all non-GETs. Moderate (50/min).

Trust-proxy is on (`app.set("trust proxy", 1)`) so `req.ip` reflects the real client behind Nginx.

### Caching

- **Settings** — 60s in-memory cache via `lib/settings.ts:getSettings()`. Invalidated on any settings PUT.
- **Templates** — 60s in-memory cache via `lib/templates.ts`. Invalidated on PUT or reset.
- **Dashboard** — 30s Redis cache (Upstash). Invalidated on any mutation that affects rooms/reservations (`invalidateDashboard()`).
- All caches are **best-effort** — if Redis or DB hiccups, the code falls back to a fresh query and only logs at debug level.

### Redis pub/sub for dashboard

When `invalidateDashboard()` runs, it both `DEL`s the cache key AND publishes to a `dashboard:invalidate` channel. A subscriber on the same Node process listens and re-deletes the key. This is a fan-out mechanism for multi-instance deployments — currently single-instance, so it's a no-op in practice.

### Production deployment

See `deploy/README.md`. Summary:
- Web: Static Vite build → Vercel
- API: Node 20 process behind Nginx on Ubuntu 22.04 VPS, managed by PM2
- DB + Auth + Storage: Supabase
- Redis: Upstash
- TLS: Certbot

---

## Migrations

> **Current scheme:** numbered SQL files live in `apps/api/migrations/` (`0001_baseline.sql` … `0042_credit_notes.sql`, 34+ applied). The production deploy script (`deploy/deploy.sh`) applies any pending ones idempotently on each deploy (already-applied files skip on the "already exists" error). The latest is **0042 (credit-note columns + `sldt_credit_note_seq`)** — it MUST run in production for the credit-note feature. To apply locally, run the SQL against the dev DB (the dev DB is the same Supabase project, so it's usually already applied).
>
> The `schema_migrations` table tracks applied migrations.

The older `apps/api/scripts/` directory holds one-off maintenance/backfill scripts (run with `npx tsx scripts/<name>.ts`, raw `postgres-js`). Historical examples below; new schema work goes in `migrations/`, not here.

| Script | Purpose |
|---|---|
| `push-otp-notif-msgs.ts` | Initial create of otps, notifications, messages tables |
| `push-message-templates.ts` | Initial create of message_templates |
| `push-doc-layout.ts` | Add doc_* columns to settings (PDF customization) |
| `push-owner-fields.ts` | Add owner_phone, owner_notify_enabled |
| `push-wifi-fields.ts` | Add wifi_ssid, wifi_password |
| `push-receipts.ts` / `push-edit-fields.ts` / `push-crm.ts` | Various column additions |
| `apply-pro-templates.ts` / `apply-final-templates.ts` | Seed template bodies |
| `migrate-booking-sources.ts` | One-time data fix when we trimmed booking_source enum |
| `drop-charge-templates.ts` | Removed the (unused) charge templates feature |
| `setup-hotel-branding.ts` | Upload the SLDT logo to public Supabase Storage |
| `delete-hotel-owner.ts` | Migration helper that reassigned references and deleted the seed admin |
| `check-rooms.ts` / `check-hotel-owner.ts` | Read-only diagnostic scripts |
| `backfill-advance-receipts.ts` / `backfill-room-rates.ts` | Data backfills for older rows |

When adding a new schema change:
1. Update the Drizzle schema file in `src/db/schema/`
2. Write a `push-<feature>.ts` script using raw SQL `alter table` etc.
3. Run `npx tsx scripts/push-<feature>.ts`
4. Update `lib/templates.ts` / route validators / shared zod schemas as needed

We don't use `drizzle-kit push` because of an ESM resolution bug with the project's `.js` import extensions on Node 24.

---

## Known issues and gotchas

### Type-checking and lint

Both apps type-check clean (`npx tsc --noEmit -p apps/api/tsconfig.json` and the web equivalent) and lint clean (`npx eslint`). Any historical ESM/CJS-interop or generated-column friction has been resolved. Run both before committing — every change this session was gated on a clean type-check + lint.

### Twilio sandbox limitations

- Recipients must join the sandbox once per number. If you suddenly stop receiving messages, the sandbox session may have expired (24h since last message).
- Production sender approval takes 2–7 days through Meta.
- Twilio error codes you'll see: 63007 (recipient not opted in), 63016 (out of 24h session window — only matters once you have approved templates).

### Upstash read-only token

The current `UPSTASH_REDIS_REST_TOKEN` is `default_ro` (read-only). This means cache writes (`setex`, `del`) fail silently. The dashboard works without caching — the failure is logged at debug level only. To enable caching, generate a read-write token in Upstash console and replace.

### Encryption key rotation

`ENCRYPTION_KEY` decrypts existing guest IDs. **Never rotate without re-encrypting all rows first**. Doing so would make all stored ID numbers undecryptable.

### Drizzle-kit doesn't work in this repo

`npm run db:push` (drizzle-kit) fails to resolve `.js` imports under Node 24. Workaround: use the migration scripts in `apps/api/scripts/` with raw SQL. This was a deliberate choice to ship faster.

### Email is no-op

All `messaging.sendEmail()` calls succeed without sending anything. The hooks remain in the code so re-enabling email later is a one-file change. If you wire up SendGrid / Resend, replace the body of `sendEmailStub` (or add a `sendEmailLive`) and toggle via env.

### "Fast" optimistic updates can lie

If the server rejects a status change after the UI has already flipped the tile, `onError` rolls back. But if the network is slow and the user navigates away mid-flip, they might miss the rollback. This is acceptable for our scale; for a busier hotel we'd want a toast on rollback.

### Old reservation/invoice numbers stay old

When we changed the format from `RES-YYYYMMDD-NNNN` → `SLDT-RES-NNNN`, **existing rows kept their old numbers**. Only new ones use the new format. The number-display code accepts either format. If you want to renumber old rows for cleanliness, write a one-off script — but most users find renumbering confuses staff who memorized the old IDs.

### "Bookings created" no longer triggers WhatsApp

Earlier versions sent guest+owner WhatsApp on every booking creation. We disabled this — only check-in and check-out trigger WhatsApp now. The `notifyGuestSms`/`notifyOwner` calls in the booking-create handler were removed entirely (not just disabled), so re-enabling means re-adding the calls.

### KYC is enforced at check-in, not at booking

A pre-booking can be created without KYC. The check-in API rejects with `KYC_REQUIRED` if the guest has no `kyc_verified_at` or `id_proof_photo_front`. Walk-in flow forces KYC up front.

### Fast Refresh sometimes invalidates AuthContext

Vite's React Fast Refresh occasionally triggers a full page reload after editing `AuthContext.tsx`. This is harmless — login session persists in localStorage.

### Owner phone receives WhatsApp via the same Twilio sandbox

If the owner's phone hasn't joined the sandbox, owner alerts won't deliver. The send still appears successful in the API logs because Twilio queues it, but the message never reaches the phone. To debug: Twilio Console → Logs → Messaging.

---

## Development workflow

### Local setup

```bash
# Once
npm install                                      # at repo root, installs all workspaces
npm -w @hoteldesk/shared run build 2>/dev/null   # no-op (shared is consumed as TS)
npm run db:seed --workspace=@hoteldesk/api       # creates settings row + admin user

# Each session
npm run dev:api                                  # API on :3001 (uses nodemon + tsx)
npm run dev:web                                  # Web on :5173 (or 5180 if 5173 is taken)
```

The API listens on `PORT` env or 3000 by default. We've been using 3001 because :3000 is taken by another local project on this dev machine. The web's `.env.local` has `VITE_API_URL=http://localhost:3001/api/v1` to match.

### Restarting after env change

API reads `.env` only on startup. Always:
1. Stop the running tsx process
2. `cd apps/api && PORT=3001 npx tsx src/index.ts`

### Git

- One branch (`main`) on `https://github.com/fynarctechworks/sldt`
- `.gitignore` excludes `.env*`, `node_modules/`, `dist/`, `*.log`, `.claude/`, `tsbuildinfo`
- Commits should follow the existing style (subject line + bullet body when multiple changes)

### Testing manually

There are some `.test.ts` files (`gst.test.ts`, `invoice-totals.test.ts`, `overlap.test.ts`) — run with `npm run test --workspace=@hoteldesk/api` (vitest). They cover the pure-function helpers, not routes.

Manual integration testing flow:
1. Login as admin
2. Create a guest with KYC
3. Create a reservation with that guest + advance
4. Check in (verify OTP works in stub mode by reading the API console)
5. Add a charge
6. Check out as **unpaid** with a reason
7. Open Collections → see the guest with balance → click Mark Received
8. Check Reports → Outstanding empties

### When something breaks

1. Check API logs (the terminal where `tsx src/index.ts` is running)
2. Check web Vite logs (the terminal where `vite` is running) — Tailwind class errors show here
3. Check browser DevTools → Network tab for the failing request
4. Common fix: restart API after editing env or schema files

### Adding a new feature checklist

1. **Data model**: edit `apps/api/src/db/schema/<file>.ts`
2. **Migration**: write `apps/api/scripts/push-<feature>.ts`, run it
3. **Shared zod**: edit `packages/shared/src/schemas/<file>.ts` if there's a request body
4. **API route**: edit `apps/api/src/routes/<file>.ts`, mount it in `index.ts` if new
5. **Web page/component**: edit `apps/web/src/pages` or `components`
6. **Sidebar nav**: if new page, edit `apps/web/src/components/Sidebar.tsx`
7. **Route**: if new page, edit `apps/web/src/App.tsx`
8. **Restart API** to pick up schema/route changes
9. **Browser hard refresh** to clear Vite HMR caches if you suspect stale code

---

## Appendix: payment-method enum migration

When we added the "unpaid" flow, the `PAYMENT_METHODS` enum became `["cash", "upi", "card", "bank_transfer", "unpaid"]`. The `payments.payment_method` column is `text` (not a Postgres enum), so this didn't need a migration.

A new column `payments.status text not null default 'received'` was added — values `received` or `pending`. Pending rows mean "promised at checkout, will collect later".

---

## Appendix: booking source migration

We trimmed `BOOKING_SOURCES` from 5 values to 3 (`walkin`, `phone_whatsapp`, `complimentary`). Existing rows with `direct` / `ota` / `credit` were migrated:
- `direct` → `phone_whatsapp`
- `ota` → `phone_whatsapp`
- `credit` → `walkin`

The Reports → Complimentary tab still works against the reduced set.

---

## Appendix: deleted features

These were built and then removed. If you find references in old commits or schema dumps, this explains why:

| Feature | Removed because |
|---|---|
| Email notifications (Resend) | Single hotel doesn't need email; SMS reaches everyone |
| Charge templates ("Laundry / Mini-bar" preset list) | Hotel adds charges ad-hoc; preset overhead not worth it |
| OTA + Credit booking sources | Local hotel, no online listings, no B2B credit |
| `Hotel Owner` seed user | Renamed/cleaned up; only `SLDT Admin` remains |
| Booking-confirmed WhatsApp (guest + owner) | Reduced WhatsApp volume; only check-in + check-out send |
| OTP email channel | WhatsApp-only deployment |
| Top-bar notification bell | Sidebar Notifications item handles this |
| Numeric badge on Collections nav | Replaced with pulsing dot for visual consistency |
| Separate per-room tax invoices as the default | Replaced by one combined invoice + printable per-room bills (June 2026). Per-room tax invoices remain an opt-in at checkout. |
| "Reissue invoices" / reshape per-room ↔ combined UI | Caused double-billing; obsoleted by the combined-invoice model (the endpoint still exists, unused) |
| Proportional advance split at per-room checkout | Now an equal split per remaining room |
| Advance/Later payment summary on PDFs | Replaced with per-payment itemised lines |

---

## Final note

This document is meant to be edited as the system evolves. When you change behavior in a way that contradicts something in this file, **update the file in the same commit**. Out-of-date docs are worse than no docs.

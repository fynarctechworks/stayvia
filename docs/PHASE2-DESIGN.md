# Stayvia — Multi-Tenant Conversion Design (Phases 2–3)

Decisions locked for the SaaS conversion. Companion to `PHASE2-TENANCY-AUDIT.md`
(generated worklist of every single-tenant assumption).

## 1. Tenancy model

- **Tenant = hotel = one row in `properties`.** Table name stays (avoids a rename storm);
  "property" and "hotel" are synonyms in code.
- New/changed columns on `properties`: `timezone text not null default 'Asia/Kolkata'`,
  `is_active boolean not null default true`. The PRIMARY-code convention dies.
- **`profiles.property_id uuid not null references properties(id)`** — every staff user
  belongs to exactly one hotel. One hotel per account in v1 (no switcher).
- **Tenant resolution:** `requireAuth` already loads the profile; it now also sets
  `req.propertyId = profile.propertyId`. `lib/currentProperty.ts` and its PRIMARY lookup
  are deleted; every `resolveCurrentPropertyId(req)` call site becomes `req.propertyId`.
  No client-supplied `X-Property-Id` — the tenant comes ONLY from the authenticated
  profile.
- RLS deny-all stays as defense-in-depth (API connects with a privileged role).
- Idempotency keys, dashboards, caches, activity log: all keyed by `property_id`.

## 2. Fresh baseline migration (squash)

New product, no deployed database → replace `migrations/0001…0053` with a single
**`0001_stayvia_baseline.sql`** generated from the current Drizzle schema PLUS:

- `property_id` on every business table that lacks it; FK + index everywhere.
- Composite uniques: what was globally unique becomes unique per hotel
  (document numbers, room numbers, guest phone dedup, settings row, etc.).
- **No global Postgres sequences** for documents — replaced by `doc_counters` (below).
- Offline tables dropped from the schema entirely (`sync_outbox`, `message_outbox`,
  `local_credentials`).
- New tables: `subscriptions`, `doc_counters`.
- `schema_migrations` runner (`scripts/migrate.mjs`) unchanged.
- `db/bootstrap/` (offline first-run) deleted; e2e harness applies `migrations/` instead
  (it already runs the runner).

## 3. Per-hotel document numbering

```sql
create table doc_counters (
  property_id uuid not null references properties(id),
  doc_type    text not null,          -- 'reservation' | 'invoice' | 'receipt' | 'credit_note'
  counter     bigint not null default 0,
  primary key (property_id, doc_type)
);
```
Atomic take-next: `update doc_counters set counter = counter + 1 where … returning counter`
(row created lazily on first use). `lib/numbers.ts` rewritten around this; formats become
`RES-0001`, `INV-0001`, `RCP-0001`, `CN-0001` per hotel (optional per-hotel prefix from
settings later). GST rule (unbroken invoice sequence per GSTIN) holds because the
sequence is per hotel.

## 4. Per-hotel settings, storage, branding, caches

- `settings`: `property_id` unique not null; `getSettings(propertyId)` cache keyed by
  hotel; every reader passes the tenant.
- Supabase Storage: all object keys prefixed `${propertyId}/…` (KYC, logos, documents).
  Signed URLs only; no cross-hotel path access.
- PDFs and WhatsApp templates read hotel name/logo/GSTIN/footer from that hotel's
  settings row — no env-level `HOTEL_DISPLAY_NAME` branding (env default stays as
  product fallback only).
- Redis dashboard cache keys: `dash:${propertyId}:…`; pub/sub channels per hotel.
- `propertyTime.ts`: reads `properties.timezone` (v1 default IST).

## 5. Signup + onboarding (Phase 3)

`POST /api/v1/public/signup` (rate-limited, unauthenticated):
`{ hotelName, ownerName, email, password, phone }` →
1. Supabase Auth `admin.createUser` (email confirmed)
2. `properties` row
3. `profiles` row (same UUID, role `admin`, property_id)
4. `settings` row with defaults
5. `subscriptions` row: `status='trialing'`, `trial_ends_at = now() + 14 days`
All in one transaction (except the Auth call — compensate by deleting the auth user if
the transaction fails).

Web: public `/signup` page → login → onboarding wizard (room types + rooms, GST details,
logo upload, owner WhatsApp number). Wizard = existing Settings/Rooms building blocks.

## 6. Subscription — one plan, Razorpay (Phase 3)

```sql
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null unique references properties(id),
  plan text not null default 'standard',
  status text not null default 'trialing',  -- trialing|active|past_due|cancelled|expired
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  razorpay_customer_id text,
  razorpay_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```
- One Razorpay **Plan** (created in dashboard; `RAZORPAY_PLAN_ID` env) + Subscriptions API.
- `POST /api/v1/billing/subscribe` → create Razorpay subscription, return checkout params.
- `POST /api/v1/billing/webhook` → verify `X-Razorpay-Signature` (webhook secret env);
  handle `subscription.activated|charged|halted|cancelled|completed` → status updates.
- **`requireActiveSubscription`** middleware on all business routes (exempt: auth, public
  signup, billing, health): `trialing` (before trial_ends_at) or `active` pass; otherwise
  `402 SUBSCRIPTION_REQUIRED`. Web intercepts 402 → billing page.
- Billing page (admin only): status, trial countdown, subscribe/renew button (Razorpay
  Checkout), payment history from webhook events.
- Env additions: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_PLAN_ID`,
  `RAZORPAY_WEBHOOK_SECRET`, `TRIAL_DAYS` (default 14).

## 7. Offline-layer removal (cloud-only)

Delete: `routes/authLocal.ts`, `routes/localFiles.ts`, `routes/sync.ts`,
`lib/localAuth.ts`, `lib/localStorage.ts`, `lib/outboxDeliverer.ts`,
`db/schema/{syncOutbox,messageOutbox,localCredentials}.ts`, `db/bootstrap/`,
`config/handshake.ts`, `scripts/gen-baseline-ts.mjs` (fix `build` script),
offline branches in `middleware/auth.ts` + `config/env.ts` (drop `OFFLINE_MODE`,
`LOCAL_JWT_SECRET`, `SLDT_SCHEMA_BOOTSTRAP`), web `lib/offlineMode.ts` + its call sites
(`AuthContext.signInOffline`, `api.ts` branches, `ResetPassword`, `AppShell`, Settings
2FA fork). Exact unhook points come from the audit doc.

## 8. Test strategy (Phase 5)

- E2E fixtures seed **two hotels** (A, B) with staff, rooms, reservations.
- Isolation suite: as hotel A admin, every list endpoint returns only A's rows; direct
  GET of B's resource IDs → 404; B's PDFs/files unreachable; reports contain only A.
- Billing lifecycle: fresh signup → trialing; expired trial → 402 + UI lock; webhook
  `activated` → unlocked.
- Existing money/date Vitest suites stay green throughout.

## Execution order

1. Offline-layer deletion (isolated, shrinks surface)
2. Schema: tenancy columns + `doc_counters` + `subscriptions` + squashed baseline
3. Tenant resolution in auth; delete `currentProperty.ts`; fix all call sites
4. Per-hotel numbering, settings, storage, caches, branding
5. Route-by-route P0 scoping fixes from the audit worklist
6. Signup + billing endpoints + middleware
7. Web: signup page, onboarding wizard, billing page, 402 handling, settings-driven branding
8. Two-hotel isolation + billing tests; full suite green

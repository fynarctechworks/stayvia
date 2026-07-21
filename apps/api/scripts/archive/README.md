# Archived scripts

> ## ⛔ DO NOT RUN ANY OF THESE
>
> Every script here predates multi-tenancy. They were written when the
> database held exactly one hotel, so **none of them filter by
> `property_id`** — running one against the current database applies its
> effect to EVERY tenant at once.
>
> Concrete examples of what that means:
>
> * `delete-hotel-owner.ts` rewrites `created_by` / `issued_by` /
>   `voided_by` / `received_by` / `performed_by` across `reservations`,
>   `invoices`, `payments` and `activity_log` with no property predicate,
>   and hardcodes one specific hotel's admin email as the destination —
>   it would rewrite audit attribution for every hotel on the platform.
> * `push-rbac.ts` issues `create table if not exists …` straight through
>   a postgres client, applying schema **outside** `apps/api/migrations/`
>   and outside the guard that blocks remote database targets. CLAUDE.md
>   forbids exactly this.
>
> They are inert while nobody runs them, but they are still executable via
> `tsx`/`node` against whatever `DATABASE_URL` happens to be in the
> environment. Treat this directory as read-only history. Schema changes go
> through a numbered migration + `npm run db:migrate`; one-off data fixes
> need a fresh, property-scoped script in `scripts/` proper.
>
> Deleting this directory entirely is a reasonable call — git history
> preserves everything below.

One-shot scripts that already did their job. Kept here for historical
reference but **not used by the running system**. If a build/deploy
needs to bootstrap a brand-new database from scratch, prefer running
migrations (`scripts/migrate.mjs`) rather than these.

| Script | What it did |
|---|---|
| `add-guest-ledger.mjs` | Added the guest ledger table — superseded by migration 0002 |
| `add-guest-photo-col.mjs` | Added guest_photo column — in baseline |
| `apply-final-templates.ts` | Loaded the polished message-template set into hotel_settings |
| `apply-pro-templates.ts` | Loaded the pro-tier template set |
| `backfill-advance-receipts.ts` | Created missing payment rows for reservations that had `advancePaid` but no payment record |
| `backfill-room-rates.ts` | Filled `rate_per_night` on reservation_rooms |
| `check-li.mjs` | Diagnostic: dumped recent invoice_line_items |
| `check-res-0010-inv.mjs` | Diagnostic: looked at a specific reservation's invoice |
| `delete-hotel-owner.ts` | Removed a stale owner row — destructive |
| `drop-charge-templates.ts` | Removed unused charge-type templates |
| `inspect-greeshmanth.mjs` | One-off inspector for a specific guest |
| `inspect-res-0005.mjs` | One-off inspector for a specific reservation |
| `migrate-booking-sources.ts` | Renamed booking-source enum values |
| `push-crm.ts` | Seeded CRM defaults |
| `push-doc-layout.ts` | Seeded receipt/invoice layout columns |
| `push-edit-fields.ts` | Added editable hotel_settings fields |
| `push-message-templates.ts` | Seeded initial template set |
| `push-otp-notif-msgs.ts` | Seeded OTP/notification messages |
| `push-owner-fields.ts` | Added owner contact columns |
| `push-rbac.ts` | Seeded RBAC role catalogue |
| `push-receipts.ts` | Migrated old receipt format |
| `push-wifi-fields.ts` | Added Wi-Fi SSID/password columns to hotel_settings |

Anything still considered useful (re-runnable backfills, regen utilities,
diagnostics you'd reach for again) stays in `scripts/` proper.

# Archived scripts

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

# Phase 2 — Multi-Tenancy Conversion Audit (Stayvia)

Synthesized from 6 area audits (routes core, routes ancillary, lib/schema/migrations, auth/identity, web SPA, offline-legacy inventory). Duplicates merged, conflicts resolved (schema-vs-route ownership noted inline). Every concrete file path preserved.

**One-line verdict:** the app is single-tenant to the core. `resolveCurrentPropertyId()` always returns the hardcoded PRIMARY property, and **not one** select/update/delete in the audited routes filters by `property_id`. Per-request tenant resolution and a `where(eq(x.propertyId, ctx.propertyId))` guard on every query are both required before a second hotel can safely exist. Additionally, `POST /api/v1/sync/ingest` is a **live cross-tenant write hole** on the cloud API today.

---

## 1) P0 tenancy gaps

Ordered: infrastructure/singletons first (unblock everything), then hard schema blockers, then per-route IDOR/leak fixes. "Systemic pattern" from the auditors: child inserts correctly inherit `propertyId` from their parent row (keep that); the fix is a tenant guard on the initial fetch of each `/:id` handler and a `property_id` predicate on every list/aggregate.

### 1a. Cross-cutting infrastructure (fix these first — they unblock the rest)

| file | issue | fix |
|---|---|---|
| `apps/api/src/lib/currentProperty.ts:21` | `resolveCurrentPropertyId()` ignores `req` and always returns the hardcoded PRIMARY property, cached in a process-global 60s singleton. THE single-tenant lynchpin — every insert stamps `property_id` from here. | Rewrite to return `req.user.propertyId` set by `requireAuth`; validate optional `X-Property-Id` against `property_members`; throw 403 `NO_PROPERTY` if absent. Delete the module cache, `clearPropertyCache`, and `PRIMARY_PROPERTY_CODE`. |
| `apps/api/src/middleware/auth.ts:86` | `requireAuth` builds `req.user` with id/email/role/permissions only — no property context, so every route falls back to the PRIMARY resolver. No per-request tenant resolution point exists. | After profile load, resolve memberships from `property_members`; set `req.user.propertyId` (default or validated `X-Property-Id`) and `req.user.propertyIds`. 403 if profile has no membership. This is where tenant resolution lands — clean it early. |
| `apps/api/src/db/schema/profiles.ts:4` | `profiles` has zero linkage to `properties` (no `property_id`, no membership table anywhere — grep returns nothing). A staff login cannot be mapped to a hotel; blocks multi-tenancy entirely. | New migration + Drizzle: `property_members(profile_id FK, property_id FK, role_id FK, is_default bool, PK(profile_id, property_id))`. Backfill one PRIMARY-property row per existing profile from `user_roles.role_id`. Mirror in baseline. |
| `apps/api/src/lib/settings.ts:7` | `getSettings()` does `SELECT … LIMIT 1` (no property key) and caches the single row process-wide. Supplies hotel name/address/GSTIN, GST slabs, `gstMode`, `invoicePrefix`, OTP-required flag, check-in/out times, Wi-Fi to ~25 call sites. Under multi-tenancy every hotel gets the PRIMARY hotel's legal identity/tax/policy. | `getSettings(propertyId)`; `WHERE property_id = $1`; cache in `Map<propertyId,{value,expiresAt}>`; `invalidateSettings(propertyId)`. Update all callers (routes, `notify.ts`, `pdf.ts`). Requires `settings.property_id` (see §5). |
| `apps/api/src/lib/availability.ts:124` | `findAvailableRooms()` selects ALL rooms (no property filter); `findRoomConflicts` (35) joins `reservation_rooms`/`reservations` unscoped. Room pickers offer other hotels' rooms; conflict labels leak other hotels' reservation numbers/guest names; re-let and extend-options span every hotel. | Add required `propertyId` param to `findAvailableRooms`/`findRoomConflicts`/`isRoomAvailable`; `eq(rooms.propertyId, …)` + `eq(reservations.propertyId, …)`. Update callers in `rooms.ts` and `reservations.ts`. `propertyToday()` at 123 also becomes per-property (§2 timezone). |
| `apps/api/src/lib/redis.ts:70` (+ `dashboard.ts:884`) | Dashboard response cached under one global key `dashboard:data`; one invalidation channel. Hotel A's occupancy/revenue/guest-names payload served verbatim to hotel B for the TTL. | `dashboardKey(propertyId) => 'dashboard:data:'+propertyId`; `invalidateDashboard(propertyId)` deletes that key and publishes `propertyId`; subscriber (140) busts only that key. Settings channel likewise carries `propertyId`. |
| `apps/api/src/lib/templates.ts:72` | Template cache is a module-global `Map` keyed by `TemplateKey` only; `loadCache` loads ALL rows; `upsertTemplate` matches on key alone. Serves one hotel's template text to another and clobbers cross-tenant on write. | Key cache by `${propertyId}:${key}`; `renderTemplate`/`getAllTemplatesForUI`/`upsertTemplate` take `propertyId` and filter `WHERE property_id=$1`; invalidate per property. Requires `message_templates.property_id` (§5). |
| `apps/api/src/lib/notify.ts:25` | `dispatchNotification` with `recipientRoles` selects profiles by role across the ENTIRE platform — every hotel's frontdesk gets in-app notifications about other hotels' reservations/guests/payments. | Add `propertyId` to `DispatchInput`; join `profiles` → `property_members` and filter by `propertyId` when expanding roles. Consider `property_id` on `notifications` rows. |
| `apps/api/src/lib/notify.ts:80` | `notifyOwner()` reads `ownerPhone` from the global `getSettings()` — hotel B's guest names/amounts get WhatsApped to hotel A's owner (PII leak to a third party). | `notifyOwner(propertyId, text)`: fetch that property's settings row for `ownerPhone`/`ownerNotifyEnabled`. Update all call sites. |
| `apps/api/src/lib/storage.ts:198` | No storage path is namespaced by property. KYC → `kyc-docs/<guestName-phone>/…`, expense bills → `expense-bills/<label>/…`, `uploadPublicFile` (422) → `documents/<path>-<label>` with `upsert:true`. Same guest at two hotels, or colliding per-hotel invoice numbers (INV-0044 at both), overwrite each other's PDFs in the shared public bucket. | Prefix every object path with `${propertyId}/…` inside `uploadKycPhoto`, `uploadExpenseAttachment`, `uploadPublicFile` (prepend in-function so callers inherit). Enables per-tenant Storage RLS later. |
| `apps/api/src/lib/permission-resolver.ts:18` | `getUserPermissions(userId)` has no property dimension — resolves one global role. A user who is admin at hotel A and frontdesk at hotel B is unrepresentable once assignment is per-property. | `getUserPermissions(userId, propertyId)` reading the per-property assignment (`property_members.role_id`); update `requireAuth` and `rbac.ts /effective`. |
| `apps/api/src/middleware/resolveReservation.ts:84` (+ `resolveInvoice.ts:65`, `resolvePayment.ts:63`, `resolveRoom.ts:72`, `resolveGuest.ts:80-126`) | Human-number → UUID resolution queries globally and caches in a process-wide LRU with no tenant key. Once numbering is per-property the same human number exists in N tenants: first resolution wins, poisoned cache serves hotel A's UUID to hotel B. | Scope the number lookup by `req` property; key the cache `${propertyId}:${number}`. Same fix across all five resolvers. |
| `apps/web/src/main.tsx:12` | Module-level `QueryClient` never cleared on sign-out/sign-in; all query keys un-tenanted (`settings-public`, `dashboard`, `guests`, `reservations`). Shared machine, hotel-A signs out → hotel-B signs in same tab: react-query serves hotel A's cached hotel name/GSTIN/logo (30-min staleTime) + dashboard/guest data. Client-side cross-hotel leak. | `qc.clear()` in `AuthProvider.signOut()` and after successful `signIn()`/`verifyMfa()`. Longer-term prepend `profile.propertyId` to every queryKey. |

### 1b. Hard schema blockers (global uniques/tables that make a 2nd hotel impossible)

Detailed migrations in §5; listed here because they are P0 — the second hotel literally cannot insert without them.

| file | issue | fix |
|---|---|---|
| `apps/api/src/db/schema/rooms.ts:19` | `rooms.room_number` GLOBALLY unique — hotel B cannot create room `201` if hotel A has one (`POST /rooms` → `DUPLICATE_ROOM` against another tenant's row). | Drop global unique; `uniqueIndex(property_id, room_number)`; mirror baseline; `resolveRoom` disambiguates by property. |
| `apps/api/src/db/schema/guests.ts:74` | `idx_guests_phone_unique` global on `phone`; migration 0030 adds global uniques on `LOWER(email)` and `(id_proof_type, id_proof_last4)`. A guest who stayed at hotel A can never register at hotel B, and the 409 confirms a row hotel B cannot see (existence leak / DPDP). | Drop the three; recreate `UNIQUE(property_id, phone)`, `UNIQUE(property_id, LOWER(email)) WHERE email<>''`, `UNIQUE(property_id, id_proof_type, id_proof_last4) WHERE last4<>''`. |
| `apps/api/src/db/schema/settings.ts:104` (+ route `settings.ts:156`) | `room_types` has no `property_id`; slug globally unique. Hotel B can't create `deluxe` if hotel A owns it; PUT/DELETE let one hotel edit/delete another's types and cascade rate changes onto its rooms (261-274 update rooms by slug with no property filter). | Add `property_id NOT NULL`; drop `unique(slug)`; add `UNIQUE(property_id, slug)`; scope all CRUD + the rate-cascade update by `propertyId`. `pdf.ts:1543` also selects ALL room_types — scope it. |
| `apps/api/src/db/schema/messageTemplates.ts:22` (+ route `settings.ts:356`) | `message_templates.key` globally unique, no `property_id` — one hotel editing `checkin_guest_sms` rewrites every hotel's guest SMS. | Add `property_id NOT NULL`; `UNIQUE(property_id, key)`; scope `lib/templates.ts` (see 1a). |
| `apps/api/src/db/schema/rbac.ts:22` (+ routes `rbac.ts`) | `roles` has no `property_id`, `roles.key` globally unique; `user_roles` PK'd on `userId` alone (one role across all properties); overrides global. Admin-created CUSTOM roles are platform-global — editing one changes permissions for every other hotel's same-named role. Permissions catalog is legitimately global. | Add nullable `roles.property_id` (NULL = system role); replace `unique(key)` with `UNIQUE(property_id, key)`; re-key `user_roles` PK `(user_id, property_id)` or fold role into `property_members`. Keep permissions global. |
| `apps/api/src/db/schema/settings.ts:20` (+ route `settings.ts:37`) | `settings` is a singleton with no `property_id`: hotel identity, GSTIN, GST slabs, `gst_mode`, OTP policy, doc branding, check-in/out times, complimentary unlock code — all global and cross-writable. The primary singleton blocker. | Add `property_id uuid NOT NULL UNIQUE REFERENCES properties(id)`; backfill PRIMARY; row-per-property created on onboarding; every settings query `WHERE property_id=$1`. |
| `apps/api/src/db/schema/activity.ts:4` (+ routes `activity.ts:50`, `audit.ts:61`) | `activity_log` has no `property_id` — the audit trail cannot be filtered per hotel, so the activity page and admin CSV export (IPs, staff emails) show every tenant's actions. (Auditor conflict: area-2 marks the route P0, area-3 marks the schema P1 — resolved as **P0**, because the route leak cannot be closed without the column.) | Add `property_id uuid` + index `(property_id, created_at)`; backfill best-effort from entity joins; `lib/activity.ts logActivity()` stamps it from `req.propertyId`; routes filter by it. |

### 1c. Per-route tenancy fixes — reservations / rooms / guests / invoices / payments / ledger / credits

| file | issue | fix |
|---|---|---|
| `apps/api/src/routes/reservations.ts:142` | `GET /` lists every reservation in the DB (joins guests+rooms unscoped) — hotel A sees hotel B's bookings, guest names, phones, KYC photo URLs. | Push `eq(reservations.propertyId, propertyId)` into both the rows and count conditions. |
| `apps/api/src/routes/reservations.ts:267` | `GET /:id` returns full detail (guest KYC/photo signed URLs, invoices, payments, wallet ledger) by bare id/RES-number to any authenticated user of any hotel. | `and(eq(id,id), eq(propertyId, propertyId))` → 404 on mismatch; apply to every `/:id` handler in the file (~35 endpoints). |
| `apps/api/src/routes/reservations.ts:634` | `POST /` stamps `propertyId` correctly but never validates `input.guestId`/`rooms[].roomId`/`coGuestIds` belong to that property — books hotel B's guest and reserves hotel B's rooms (status flip at 887). | Inside the tx verify `guests.propertyId` and every `rooms.propertyId` equal the resolved property. Same for add-room, swap-room, swap-room-segment, extend-continue moves, assign-guest. |
| `apps/api/src/routes/reservations.ts:1177,1069` | `POST /:id/early-check-in` + `/preview` mutate dates/totals and lock rooms for any reservation id, no tenant check. | Tenant-guard the reservation fetch. |
| `apps/api/src/routes/reservations.ts:1320` | `POST /:id/check-in` flips any tenant's reservation+rooms; OTP-required and KYC gates read the single global settings row (tenant B's policy dictated by tenant A). | Tenant-guard; `getSettings(propertyId)`. |
| `apps/api/src/routes/reservations.ts:2093` (+ invoice inserts 1843, 2349, 6052, 6400, 6791, 6875, `autoConsolidatePerRoomInvoices:5805`) | `POST /:id/check-out` and per-room checkout issue GST invoices for any tenant's reservation; snapshot `hotelName`/`hotelAddress`/`hotelGstin` come from the global settings row — **every tenant's tax invoices carry the PRIMARY hotel's legal identity/GSTIN → legally invalid documents.** (P0 branding.) | Tenant-guard the fetch; source hotel identity/GST from per-property settings at every invoice-insert site. |
| `apps/api/src/routes/reservations.ts:2635,2724,3009` | `make-complimentary`, `cancel` (inserts refund payments + wallet credits), `no-show` operate on any tenant's reservation — cross-tenant money mutations. | Tenant-guard the initial fetch in each; downstream inserts inherit `r.propertyId`. |
| `apps/api/src/routes/reservations.ts:3112,3188,3334` | `swap-room`/`swap-room-segment` accept `newRoomId`/`toRoomId` with no property validation — point a booking at another hotel's room, flip its status, insert `maintenanceIssues` against it. | After tenant-guarding the reservation, verify target room `propertyId` before any status flip/maintenance insert. |
| `apps/api/src/routes/reservations.ts:3586,3806,4093,4184,4406,4486` | `extend`, `extend-split`, `extend-options` (returns cross-hotel `findAvailableRooms` alternatives), `extend-continue`, `late-checkout`, `add-room` mutate any tenant's reservation. | Tenant-guard each fetch; property-scope `findAvailableRooms`/`findRoomConflicts`. |
| `apps/api/src/routes/reservations.ts:4769,4811,3547` | `PATCH`/`DELETE /:id/charges/:chargeId` fetch/update/delete `additional_charges` by `chargeId` ALONE — charge never checked against reservation `:id` or property. Any user edits/deletes any charge on any hotel's reservation. `POST /:id/charges` inserts without confirming the reservation. | Add `eq(additionalCharges.reservationId, id)` to lookup/update/delete WHERE + tenant guard on the reservation. |
| `apps/api/src/routes/reservations.ts:4910` | `GET /:id/invoice-preview` renders a full invoice PDF (guest PII + money) for any tenant, global settings supply branding. | Tenant-guard; per-property settings render. |
| `apps/api/src/routes/reservations.ts:5237,5330,5361` | `POST /:id/payments` records money against any tenant's reservation/invoice; wallet-credit GET/POST read and SPEND any guest's wallet cross-tenant. | Tenant-guard the reservation fetch; wallet endpoints additionally guard the guest's `propertyId`. |
| `apps/api/src/routes/reservations.ts:5484` | `POST /:id/rooms/:roomId/assign-guest` validates guest exists but not `guests.propertyId` — links another hotel's guest onto the booking (later billed via per-room `billedTo`). | Add `propertyId` equality to the guest lookup. |
| `apps/api/src/routes/reservations.ts:5535,5871,6243,6543` | `checkout-quote`, per-room `check-out`, `POST /:id/invoice`, `convert-invoices` (voids/credit-notes GST docs) — full per-room billing operates on any tenant's reservation. | Tenant-guard the reservation fetch at the top of each handler; every downstream query keys off it. |
| `apps/api/src/routes/reservations.ts:1034,1547,2052,2535` | Guest/owner WhatsApp/SMS use `env.HOTEL_DISPLAY_NAME` (single env var) — every tenant's guests get messages branded as the PRIMARY hotel; `notifyOwner` targets one configured number. (P0 branding.) | Take display name + owner contact from per-property settings; thread through `renderTemplate`/`notifyOwner`. |
| `apps/api/src/routes/rooms.ts:46,61,98,118,150,190` | `GET /`, `GET/PUT /:id`, `PATCH /:id/status`, `delete-impact`, `DELETE /:id` — every room query unscoped; staff list, rename, re-rate, status-flip, hard-delete another hotel's rooms. | `eq(rooms.propertyId, …)` on list; `and(eq(id,id), eq(propertyId,…))` on `/:id`. |
| `apps/api/src/routes/rooms.ts:29` | `GET /availability` → `findAvailableRooms` offers hotel B's rooms and lets hotel B's bookings block hotel A. | Thread `propertyId` into `findAvailableRooms` (see 1a) and pass it here. |
| `apps/api/src/routes/guests.ts:88,143` | `GET /` returns the full guest directory of every hotel (names, phones, emails, ID last4, photos, lifetime spend). | `eq(guests.propertyId, …)` in rows + count + the batched agg SQL at 143. |
| `apps/api/src/routes/guests.ts:192,709-770,928-979` | `GET /check-duplicate` matches phone/email/ID across ALL tenants and returns matched name/phone/email/`idProofLast4` — direct cross-tenant PII disclosure. Same leak in `POST /` pre-flight (409 body `matches`) and `PUT /:id` in-tx probes. | Scope every dup condition by `propertyId`. |
| `apps/api/src/routes/guests.ts:288,456,556` | `GET /:id`, `/:id/outstanding`, `/:id/reservations` return any tenant's guest (stats, balances, stay history) by bare id. | `and(eq(id,id), eq(propertyId,…))` then 404. |
| `apps/api/src/routes/guests.ts:1075,1157,1185` | KYC upload / GET (signed URLs to ID-proof images) / DELETE all cross-tenant — view, replace or delete a guest's government ID docs (DPDP). | Tenant-guard the guest fetch in all three; prefix KYC storage folders with property id. |
| `apps/api/src/routes/guests.ts:1224,1263,1297,1357,1391` | `tags`, `vip`, `blacklist`, `preferences`, `consent` mutate any tenant's guest — hotel A can blacklist hotel B's guest, blocking their bookings there. | `and(eq(id,id), eq(propertyId,…))` on every UPDATE. |
| `apps/api/src/routes/guests.ts:1426-1541` | Follow-ups/notes GET+POST unscoped; `PATCH /:id/follow-ups/:followUpId` updates by `followUpId` only (ignores `:id`); `follow-ups/due` returns ALL hotels' pending follow-ups with names+phones. | Guard through `guests.propertyId`; PATCH also requires `eq(guestFollowUps.guestId, id)`. |
| `apps/api/src/routes/guests.ts:1585,1648` | `DELETE /:id` and `abandon-cleanup` hard-delete any tenant's guest + phone history + KYC files by bare id. | Tenant-guard the fetch before any delete. |
| `apps/api/src/routes/invoices.ts:30,111,181` | `GET /`, `/summary`, `/export` (streams up to 5000 invoices with PII, GSTINs, payments, issuers across ALL tenants) — zero property scoping. | Extract the copy-pasted filter block into a helper; add `eq(invoices.propertyId, …)` once. |
| `apps/api/src/routes/invoices.ts:519,540,597,626` | `GET /:id`, `/:id/pdf`, `room-bill-options`, `room-bill/:roomNumber/pdf` serve any tenant's invoice detail/PDF by UUID or INV-number. | `and(eq(id,id), eq(propertyId,…))`. |
| `apps/api/src/routes/invoices.ts:803,969` | `PATCH /:id` edits any tenant's issued GST invoice — line items, totals, bill-to identity, even the parent reservation's stay dates. | Tenant-guard the invoice fetch; keep paid-invoice lock. |
| `apps/api/src/routes/payments.ts:30` | `POST /` records a payment against any tenant's invoice (fetched by bare id; row lands in the OTHER tenant's books), mutating their totals and reservation balance. | Guard the invoice fetch with `eq(invoices.propertyId, …)`. |
| `apps/api/src/routes/payments.ts:159,175,209,250,315` | `GET /` lists latest 500 payments across ALL tenants; `receipt`, `PATCH`, `void`, `mark-received` mutate any tenant's payment and cascade into their invoice+reservation balances. | `eq(payments.propertyId, …)` on list; guarded single-row fetches on `/:id`. |
| `apps/api/src/routes/ledger.ts:16,42,80` | `GET/POST /guests/:id/ledger` + `cashout` + `adjust` verify the guest exists but not its property — hotel A can view hotel B's wallet and CASH OUT its balance (real money out). | Change existence probe to `and(eq(guests.id,id), eq(guests.propertyId,…))`. |
| `apps/api/src/routes/credits.ts:28` | `GET /guests` raw SQL over `guests ⋈ guest_ledger` with no property predicate — every hotel's guests, wallet balances, cross-tenant `totalCredit`. | Add `WHERE g.property_id = ${propertyId}`. |

### 1d. Per-route tenancy fixes — dashboard / reports / calendar / search / expenses / maintenance / housekeeping / amenities / messages / otp / settings / rbac / properties

| file | issue | fix |
|---|---|---|
| `apps/api/src/routes/dashboard.ts:62` | `buildDashboard()` runs ~17 queries (rooms, occupancy, check-ins/outs, overdue, revenue today/MTD, outstanding, forecast, arrivals, no-shows, revenue-by-method, liveReservations, activity feed) with zero property filters. | `buildDashboard(propertyId)`; `eq(<table>.propertyId,…)` on every Drizzle query and `AND r.property_id = ${propertyId}` in every raw SQL block. |
| `apps/api/src/routes/reports.ts:37,70,183,253,296,384,552,586,647,703,748,800` | Every report is unscoped: occupancy (37), daily-ledger (70, 3 subqueries), revenue (183), collections (253), gst-summary (296 — hotel A's GST filing includes hotel B's invoices), outstanding (384, 4 queries), room-performance (552), outstanding/remind/:guestId (586 — bare-id guest lookup + `env.HOTEL_DISPLAY_NAME` SMS), credit-bookings (647), guests (703), pace/pickup (748/800). | Add `property_id` predicate to every query / raw SQL subquery; replace `HOTEL_DISPLAY_NAME` with per-property name. |
| `apps/api/src/routes/calendar.ts:42` | Month calendar returns every hotel's reservations (guest names, room numbers) overlapping the month. | `eq(reservations.propertyId, …)` on the where + room-number subquery join. |
| `apps/api/src/routes/search.ts:45` | Cmd-K global search ILIKEs across all guests (phone, ID last4), reservations, rooms — cross-hotel PII leak on every keystroke. | `eq(propertyId,…)` on all three fan-out queries. |
| `apps/api/src/routes/expenses.ts:107,180` | `GET /` list and `/summary` build the where clause without `eq(expenses.propertyId,…)` even though the column exists and POST stamps it — lists/totals mix all hotels. | Push `eq(expenses.propertyId,…)` into the shared filter builder for both. |
| `apps/api/src/routes/expenses.ts:246,371,431,476` | `GET /:id`, `PATCH /:id`, `POST /:id/bill`, `DELETE /:id` fetch/update/delete by bare UUID — cross-tenant IDOR on expenses + signed attachment URLs. | Every `eq(expenses.id, id)` → `and(eq(id,id), eq(propertyId,…))`. |
| `apps/api/src/routes/maintenance.ts:25,136,230,300` | List, `loadIssueDetail`, `PATCH /:id`, `POST /:id/comments` query by bare id/filters with no property scope; `propertyId` column is nullable. | `eq(maintenanceIssues.propertyId,…)` everywhere; make column NOT NULL after backfill (§5). |
| `apps/api/src/routes/housekeeping.ts:38,83,134,159,182` | `GET /` lists all rooms; `PATCH /:roomId`, `maintenance`, `notes`, `resolve` mutate any room by bare UUID — flip another hotel's room statuses. | `eq(rooms.propertyId,…)` on list and every update WHERE (404 when room not in caller's property). |
| `apps/api/src/routes/amenities.ts:90,207` | Room-scoped `amenities`/`images` endpoints never verify the room belongs to the caller's property — cross-tenant read/write of room images/amenities by bare `roomId`. | Guard every handler with `and(eq(rooms.id, roomId), eq(rooms.propertyId,…))` first. |
| `apps/api/src/routes/messages.ts:14,118` | `GET /messages/staff` lists every active profile (no `property_id`) — staff-chat picker shows all hotels' employees; `POST /` only checks recipient exists, allowing cross-tenant DMs. | Add property membership to `profiles`; filter the staff list and recipient check by caller's property. |
| `apps/api/src/routes/otp.ts:48,166,250` | `POST /otp/send` resolves reservation/guest by bare UUID (no property check); phone-anchored verify matches `otps` by target only — two hotels checking in the same phone collide and consume each other's codes. Body/subject use `env.HOTEL_DISPLAY_NAME`. | Scope reservation/guest lookups by property; add `otps.property_id`, stamp on send, filter every verify `whereClause`; pull hotel name from per-property settings. |
| `apps/api/src/routes/settings.ts:37,54,99,144` | `GET /settings`, `/public`, `PUT /settings`, `verify-access-code` all operate on `db.select().from(settings).limit(1)` — single global row shared and writable across tenants. Primary singleton blocker. | `property_id` on settings (§5); row per property on onboarding; every query `where(eq(settings.propertyId,…))`. |
| `apps/api/src/routes/settings.ts:400,405` | `staffRouter GET /` returns every profile; `PUT/DELETE/:id`, `DELETE /:id/hard` operate on any user id; staff create inserts a profile with no property assignment. Hotel A's admin can list/edit/deactivate/delete/create hotel B's staff. | Filter list by caller's property via `property_members`; guard every `:id` mutation with same-property check; stamp creator's `propertyId` on the new profile in the same tx. |
| `apps/api/src/routes/rbac.ts:31,125,219` | `GET /roles` lists all tenants' custom roles; `POST` enforces global-unique key; `PATCH/DELETE` let an admin rewrite/delete another hotel's role (instantly changing that hotel's staff permissions); `PUT /users/:userId/role`, overrides, `effective` accept any userId. | Scope role list/create/update/delete to system roles + caller's property; verify target user belongs to caller's property and roleId is system-or-caller's-property before any assignment. |
| `apps/api/src/routes/properties.ts:31,62` | `GET /properties` returns every property row (name, GSTIN, address, phone) to anyone with `manage_settings`; `PATCH /:id` updates any property by id — rename, re-GSTIN, deactivate another hotel. | Scope to caller's membership; `PATCH` 404 unless id ∈ `req.user.propertyIds`; cross-property edits for platform superadmin only. |
| `apps/api/src/routes/sync.ts:48` (+ `lib/sync/ingest.ts`) | **P0 write hole.** `POST /api/v1/sync/ingest` is mounted on the cloud API (index.ts:224-226, mounted whenever OFFLINE_MODE off = always in SaaS). Auth is a per-device bearer token vs `sync_devices`; `ingest.ts` then does whole-row upserts/deletes VERBATIM into reservations, payments, invoices, guests, guest_ledger, expenses, maintenance_issues, housekeeping_tasks, reservation_rooms, reservation_co_guests — bypassing `requireAuth`, RBAC, and all property scoping. Any surviving desk token can write rows with ANY `property_id`. | Delete `routes/sync.ts` + `lib/sync/ingest.ts`; remove import (index.ts:32) and mount (224-226); immediately `UPDATE sync_devices SET revoked_at=now()` until dropped. See §3. |

**Note on `POST /properties` / onboarding and provisioning:** these are P0 but tracked in §4 (signup) — `properties.ts:8` (no signup flow) and `migrations/0013:70` (provisioning exists only as PRIMARY bootstrap).

---

## 2) P1 per-hotel conversions

### Numbering (per-property sequences + prefixes + composite uniques)
- `apps/api/src/lib/numbers.ts:3` — all four formatters hardcode `SLDT-` (`invoiceNumber()` even ignores its `prefix` arg). Take a per-property prefix from settings; `${prefix}-RES-${fmt4(seq)}` etc.
- `apps/api/src/lib/availability.ts:285-318` — `nextDailySequence`/`nextInvoiceSequence`/`nextReceiptSequence`/`nextCreditNoteSequence` call `nextval()` on global `sldt_reservation_seq`/`sldt_invoice_seq`/`sldt_receipt_seq`/`sldt_credit_note_seq`. One shared number stream for all tenants; GST requires a consecutive serial per GSTIN. Move to a `property_counters` table (§5); move allocators into `numbers.ts`.
- `apps/api/src/lib/receipt.ts:9` — `generateReceiptNumber` passes the dead `SLDT-RCP-%` LIKE + hardcoded prefix. Signature `generateReceiptNumber(propertyId, exec)`; allocate from `property_counters('receipt')`. Callers: `reservationBalance.ts:419`, payment routes.
- Allocation sites in `reservations.ts`: 786, 1820, 3929 (extend-split), 4328 (extend-continue), 6944 (credit note). Route them through the per-property allocator.
- `apps/api/src/routes/invoices.ts:727` + `payments.ts:465` — `collectCompanionCollections` matches payments by notes text `Collected at check-out of <RES-number>`; per-tenant numbers repeat across hotels → another tenant's collections summed into this invoice's footer. Constrain the query by `propertyId`; better, add a real `source_reservation_id` column.
- `apps/api/src/lib/pdf.ts:734` — credit-note reversal regex `/reversing\s+(SLDT-INV-\d+)/i` breaks per-hotel; change to prefix-agnostic `/reversing\s+([A-Z0-9]+-INV-\d+)/i` or store the reversed invoice number explicitly.
- `apps/api/src/routes/payments.ts:26,399` — marker regex `Collected at check-out of SLDT-RES-\d+` hardcodes the SLDT prefix; generalise to the per-property prefix (P2 cosmetic but same root).
- Schema composite uniques (see §5): `reservations.ts:22`, `invoices.ts:11` (invoice_number + receipt_number:95).

### Settings (per-property row) & policies
- `apps/api/src/db/schema/settings.ts:20` + `lib/settings.ts:7` + route `settings.ts` — covered as P0 in §1 (the singleton is a blocker); the P1 remainder is threading `getSettings(propertyId)` through the ~25 read sites and the per-property cache map.
- `apps/api/src/routes/settings.ts:589` — "last active admin" guard counts admins across the whole `profiles` table; count within the target user's property once memberships exist.
- `apps/api/src/routes/properties.ts:1` — header comment + `GET /me` encode single-tenant; rewrite `/me` to resolve from `req.user`'s profile; add `POST /properties` onboarding path.

### Storage (per-tenant path prefixes)
- `apps/api/src/lib/storage.ts:198` — P0 in §1 (path namespacing); the P1 remainder is per-tenant Supabase Storage RLS policies once prefixes land.
- `apps/api/src/routes/payments.ts:408` — `regenerateInvoicePdfForReservation` re-uploads to `invoices/<invoiceNumber>.pdf`; per-tenant invoice numbers collide on the same bucket key, silently overwriting each other's publicly-linked PDFs (WhatsApp links guests received). Namespace `p/<propertyId>/invoices/…` (same for `receipts/…` at reservations.ts:1018/1530) and scope the number lookup by property.
- `apps/web/src/pages/Settings.tsx:749` — `HotelSettings`/HotelTab have no `hotelLogoUrl` field or upload control, yet receipts/PDFs/WhatsApp depend on `settings.hotelLogoUrl`. Add an upload control writing to `properties/{propertyId}/logo`, add the field to the PUT payload, invalidate `settings-public` on save.
- P2 storage-path prefixes: `expenses.ts:319` (expense bills), `amenities.ts:207` (room images) — prefix with `${propertyId}/`.

### Caches (per-tenant keying)
- `apps/api/src/lib/redis.ts:70` + `dashboard.ts:884` — P0 in §1 (cross-tenant dashboard leak). 
- `apps/api/src/routes/housekeeping.ts:122` (+ `amenities.ts`) — `invalidateDashboard()` busts the single global key on every action; becomes `invalidateDashboard(propertyId)` once the key is per-property.
- `apps/api/src/lib/templates.ts:72` — P0 in §1 (template cache).
- `apps/api/src/middleware/idempotency.ts:76` — keys scoped `${userId}::${routeKey}::${key}` with no tenant component; on all money routes. If a user ever acts on >1 property, a replayed key returns the OTHER property's cached response/body. Include `propertyId` in `compositeId`; store `property_id` on `idempotency_keys`.
- `apps/web/src/main.tsx:12` — P0 in §1 (client react-query cache).

### Branding (per-property identity)
- `apps/api/src/routes/reservations.ts:1034` (+2093 invoices, otp.ts:166) — **P0** in §1 (guest-facing branding + legal invoice identity).
- `apps/api/src/config/env.ts:121` — `HOTEL_DISPLAY_NAME` (default `Stayvia`) and `GOOGLE_REVIEW_URL` are per-deployment env vars used in guest messages; move both to per-property settings (`settings.hotelName` exists; add `settings.googleReviewUrl`), then delete the env vars.
- `apps/api/src/routes/auth.ts:348` — password-change OTP WhatsApp branded with `env.HOTEL_DISPLAY_NAME`; use `properties.name` from membership.
- `apps/api/src/lib/templates.ts:32` — `TEMPLATE_DEFAULTS` end with `— {hotel}, Sabbavaram`; strip `, Sabbavaram` (or add a `{hotel_city}` var from the property row). Existing PRIMARY rows keep stored text.
- `apps/web/src/pages/NewReservation.tsx:1150` + `ReservationDetail.tsx:1578,1655` — receipt `logoUrl: settings.hotelLogoUrl ?? "/logo.jpg"` prints the bundled Stayvia product logo as the hotel's logo/watermark on GST receipts. Drop the fallback; pass null (modals already render no logo when null).
- `apps/web/src/auth/AuthContext.tsx:14` — `Profile` carries no tenant identity; extend `/auth/me` + type with `propertyId`, `hotelName`, `hotelLogoUrl`; expose from `useAuth()` for shell branding + tenant-scoped query keys.
- `apps/web/src/routes/auth.ts:153` / `/auth/me` — return `currentPropertyId` + membership list `(id, name, code)`; extend `AuthContext` to store it and send validated `X-Property-Id`.
- P2 branding: `Sidebar.tsx:147` (static "Stayvia / HOTEL OS" — render current hotel name), `Settings.tsx:1102` (Wi-Fi placeholder `sldt2026`), `Login.tsx:473` (`VITE_ADMIN_CONTACT_EMAIL`), comment-only SLDT prefixes in `Invoices.tsx:341` / `ReservationDetail.tsx:441,5403,5482` / `dashboard.ts:833`.

### Timezone / locale (P1)
- `apps/api/src/lib/propertyTime.ts:6` — `PROPERTY_TIMEZONE` hardcoded `Asia/Kolkata`; `properties.timezone` exists but is never read. Parameterize helpers by the property's tz (`propertyToday(tz)`, `propertyDayStart(dateStr, tz)`); callers (`availability.ts:123`, dashboard, reports) pass the tenant's tz. `reports.ts:26 rangeDefaults()` defaults to server-local month — derive from `propertyToday()`.
- P2 locale: `lib/invoiceBuilder.ts:103,276,293` (hardcoded ₹), `lib/messaging.ts:120` (`normalizeIndianNumber` assumes +91), `pdf.ts:177 inr()`, web `lib/utils.ts:8` (INR/en-IN, Asia/Kolkata, 10-digit phone). Acceptable if India-only; document the constraint.

### Schema `property_id` additions that are P1 (scoping-via-parent works today but a column is cleaner)
- `apps/api/src/db/schema/maintenance.ts:42` — make `maintenance_issues.property_id` NOT NULL (backfill from `rooms.property_id`).
- `apps/api/src/db/schema/otps.ts:9` — add `otps.property_id` (P1 for OTP scoping tied to §1d otp route fix; the throttle-per-tenant refinement is P2).

---

## 3) Offline-layer deletion plan (cloud-only Stayvia SaaS)

The Tauri desktop shell and its sidecar runtime are being dropped. The offline layer is a tangle where **deleting a leaf file first breaks `tsc`** — the forcing order is: unhook the wiring hubs → strip `OFFLINE_MODE` branches in the same commit → delete now-orphaned files → drop DB objects last. `OFFLINE_MODE` is also a runtime security kill-switch (if ever set on the SaaS, `requireAuth` flips to local-JWT and Supabase/Upstash validation goes optional), so removing the flag is itself hardening.

### Step 0 — P0, do immediately (before or with the API deletion)
1. **Close the write hole.** Delete `apps/api/src/routes/sync.ts` and `apps/api/src/lib/sync/ingest.ts`; remove the import (`index.ts:32`) and mount (`index.ts:224-226`). Run `UPDATE sync_devices SET revoked_at=now()` now (table dropped later). Only `routes/sync.ts` and the standalone `scripts/sync-safety-test.mjs` import `ingest.ts`.
2. **Verify triggers on prod.** `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'sync_capture_%'` — migration 0052 attaches AFTER INSERT/UPDATE/DELETE triggers to all 10 business tables and `scripts/migrate.mjs` applies every numbered file unconditionally, so `sync_outbox` is likely growing on the cloud DB with a full row image per write, pooling all tenants' data. (Drop scheduled in Step 4.)
3. **Rebuild the e2e harness in cloud mode BEFORE deleting the API layer** so coverage never hits zero. `e2e/global-setup.ts:125` boots the API with `OFFLINE_MODE=1`, `SLDT_SCHEMA_BOOTSTRAP=1`, `LOCAL_JWT_SECRET`, `SLDT_STORAGE_DIR`, initdb's a throwaway cluster from `apps/web/src-tauri/resources/pgsql` (untracked leftover), waits on `local_credentials`, plants `window.__TAURI_INTERNALS__` (fixtures) and logs in with seeded PIN `424242`; `smoke.spec.ts` tests the PIN screen. Rebuild: plain local Postgres (binaries vendored OUTSIDE `src-tauri`) + local Supabase/GoTrue or a test auth shim, password login, drop the `__TAURI_INTERNALS__` init + DESK_ADMIN PIN fixture. Also fix `playwright.config.ts:31` (`--workspace @hoteldesk/web` → `@stayvia/web`, renamed in Phase 0).

### Step 1 — unhook wiring + strip `OFFLINE_MODE` (single commit; `tsc` forces completeness)
Unhook points, all edited together:
- `apps/api/src/config/env.ts:73` — remove `applyHandshake` import+call, the `OFFLINE` const, `cloudString`/`cloudUrl` helpers (make `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_JWT_SECRET`/`UPSTASH_*` unconditionally required), and keys `OFFLINE_MODE`/`SLDT_SCHEMA_BOOTSTRAP`/`LOCAL_JWT_SECRET`. (Remove `HOTEL_DISPLAY_NAME`/`GOOGLE_REVIEW_URL` after per-property branding lands — §2.)
- `apps/api/src/config/handshake.ts:42` — delete the file (Tauri stdin handshake + `%LOCALAPPDATA%\SLDT\messaging.env`); imported/executed at load by `env.ts:6,11`.
- `apps/api/src/index.ts:12` — delete imports of `outbox`/`outboxDeliverer`/`sync/pusher`/`db/bootstrap`/`seedAdmin`/`authLocal`/`localFiles`/`sync`; hardcode `app.set('trust proxy', 1)`; delete or stub `/system/status` (148-167); remove the OFFLINE-conditional auth mount ordering (170-181, incl. `authLocalRoutes` mounted ONLINE for `/auth/provision-local`); remove `localFiles` mount (186-188), `sync` mount (224-226), drainer/pusher boot (242-253), `offlineFirstRun` (256-272), the offline `unhandledRejection` keep-alive (298-305).
- `apps/api/src/middleware/auth.ts:39` — remove the `verifyToken` import and the `env.OFFLINE_MODE` branch; keep only `supabaseAdmin.auth.getUser`.
- `apps/api/src/lib/messaging.ts:230` — remove the `enqueueMessage` import + the OFFLINE branches in `sendSms` (230-236)/`sendEmail` (243-246)/`isEmailConfigured` (252); make `directSenders` (214-224) module-private.
- `apps/api/src/lib/storage.ts` — strip `env.OFFLINE_MODE` branches (199, 218, 228, 293, 308, 329, 339, 426-433).
- `apps/api/src/lib/pdf.ts:234,246` — hardcode `networkidle0`; `inlineLogo` → pass-through.
- `apps/api/src/lib/logger.ts:7`, `apps/api/src/lib/otp.ts:14` (pepper → `SUPABASE_JWT_SECRET` only), `apps/api/src/lib/supabase.ts` (export a plain non-null client, drop the throwing Proxy), `apps/api/src/lib/redis.ts:20` (make Upstash required; keep in-process fallback for `NODE_ENV=test` only).
- `apps/api/src/routes/auth.ts:376` — strip OFFLINE branches (`/logout` no-op 140, `PUT /me` email-sync skip 188, OTP phone-fallback 288-297/435-439, devCode reveal 369, `verifyCurrentSecret` local_credentials 376-398, password write 470-484); drop `hashSecret`/`verifySecret`/`localCredentials` imports (15,16).
- `apps/api/src/routes/settings.ts:419` — remove staff create/update/hard-delete OFFLINE branches (419-453, 500-517, 620) + `localCredentials`/`hashSecret` imports (31,32).
- `apps/api/src/routes/otp.ts:202` — remove the `revealForOffline` code-reveal branch + `offlineCode`/`offline` response fields (212-213).
- `apps/api/src/routes/authLocal.ts` — after unhooking `index.ts`, the file is dead; `/provision-local` was reachable online and mirrored password hashes into `local_credentials` on the shared DB.

### Step 2 — delete orphaned files (now zero importers) + fix build
- Delete: `apps/api/src/routes/authLocal.ts`, `apps/api/src/routes/localFiles.ts`, `apps/api/src/lib/localAuth.ts`, `apps/api/src/lib/localStorage.ts`, `apps/api/src/lib/outbox.ts`, `apps/api/src/lib/outboxDeliverer.ts`, the whole `apps/api/src/lib/sync/` dir (`pusher.ts`, `ingest.ts`), the whole `apps/api/src/db/bootstrap/` dir (`index.ts`, `baseline.sql` 4397 lines, `baseline.ts`, `seedAdmin.ts`).
- **Port before deleting:** `seedRbacCatalog` in `db/bootstrap/seedAdmin.ts` is the only RBAC-catalog seeder — extract it into a shared lib used by the signup/provisioning flow (§4) so fresh SaaS DBs get the permission catalog + system roles. `seedAdmin`'s PIN-`424242`/`ensurePrimaryProperty` logic is discarded.
- **Build fix (same commit as bootstrap deletion):** `apps/api/package.json:10` build is `node scripts/gen-baseline-ts.mjs && tsc …`; change to `tsc -p tsconfig.json` and delete `apps/api/scripts/gen-baseline-ts.mjs`. Otherwise `npm run build` (and the e2e prereq + Docker image) break.
- Delete schema files + barrel exports: `apps/api/src/db/schema/localCredentials.ts`, `messageOutbox.ts`, `syncOutbox.ts`, and their re-exports at `db/schema/index.ts:20-22`.
- Docs/scripts (no code importers, safe any time): `apps/api/docs/offline-sync-runbook.md`, `apps/api/scripts/backfill-to-local.mjs`, `apps/api/scripts/sync-safety-test.mjs`.

### Step 3 — web SPA offline strip
- Delete `apps/web/src/lib/offlineMode.ts`; strip all usages: `lib/api.ts` (imports 3-8, `authHeader` local-JWT 22-25, `refreshLocalSession` 56-89, `handle401` offline 94-109 → keep only Supabase token path), `auth/AuthContext.tsx` (`signInOffline`, `offline` flag, synthetic `local` session 74-89, offline profile-load 132, `signOut` branch 243-248), `pages/Login.tsx` (PIN branches 22, 76, 88-94, 383-413), `components/AppShell.tsx` (`offlineMode` import 7, `SystemStatus` 20-25, `/system/status` poll 116-123, online/offline listeners 126-136, desk connectivity strip 233-261), `pages/Settings.tsx` (import 23, password-change copy 273-345, `TwoFactorCard` offline wrapper 456-472 → collapse to `TwoFactorCardOnline`), `pages/ResetPassword.tsx:19`, `components/OtpModal.tsx` (`offlineCode`/`offline` 33-38, verify-step banner 175-186). Then `npx tsc -b apps/web`.
- Delete `GET /api/v1/system/status` (`index.ts:148`) in the same release as the AppShell strip.
- Reword comment-only offline references: `CheckInReceiptModal.tsx:151`, `PdfPreviewModal.tsx:29`, `api.ts:14-21`.

### Step 4 — drop DB objects (NEW numbered migration; **flag for deploy** — auto-applies)
Run only AFTER the referencing code is deployed-removed. Keep 0050-0053 immutable; add a new migration that:
- `DROP TRIGGER sync_capture_<table>` on reservations, reservation_rooms, reservation_co_guests, invoices, payments, guests, guest_ledger, expenses, maintenance_issues, housekeeping_tasks;
- `DROP FUNCTION sync_capture()`; `DROP SEQUENCE sync_change_seq`;
- `DROP TABLE sync_outbox, sync_applied_log, sync_devices, message_outbox, local_credentials` (destructive — `local_credentials` needs explicit human approval per repo rules).
- Exclude all five tables from any regenerated baseline. Update the CLAUDE.md hard rule about mirroring migrations into `baseline.sql`.

### Step 5 — desktop leftovers on disk
- `git rm apps/web/src-tauri/gen` (4 tracked schema JSONs, ~5.4k lines, accidentally committed in the Phase-0 removal); delete the whole `apps/web/src-tauri/` dir from disk once the e2e harness no longer needs `resources/pgsql`; delete `dist-desktop/`, `e2e-app/`, `playwright-report-app/`; clean `.gitignore` `src-tauri` entries.

---

## 4) Signup / onboarding requirements discovered

There is **no way to onboard a hotel today**: `POST /properties` is deliberately not exposed, no `/signup` endpoint or web page exists, and the only tenant-minting paths are the dev seed and migration 0013's one-time PRIMARY bootstrap. Requirements uncovered:

1. **`property_members` table** (`profiles.ts:4`, `auth.ts:86`) — the prerequisite for everything: `(profile_id, property_id, role_id, is_default, created_at)`, PK `(profile_id, property_id)`. Backfill existing profiles to PRIMARY.
2. **Atomic provisioning routine** — `apps/api/src/lib/provisionProperty.ts` (or a signup route) that in ONE transaction inserts: `properties` row, per-property `settings` row, default `room_types` + rate plans, `property_counters` rows (§5), `property_members(admin)`, the admin role assignment (reuse ported `seedRbacCatalog` for the one-time global RBAC catalog + system roles). Migration 0013's PRIMARY-only rate-plan seeds (216-235) are not a reusable path.
3. **`POST /signup`** (`properties.ts:8`) — unauthenticated, rate-limited, Zod-validated: create the Supabase auth user, then run the provisioning tx; roll back and delete the Supabase user on failure.
4. **Web `/signup` page** (`apps/web/src/App.tsx:34`) — only `/login` and `/reset-password` are public. Add a lazy-loaded `/signup` (hotel name + owner email/password) calling the new endpoint, then sign in. Register beside `/login`.
5. **Staff creation stamps property** (`settings.ts:405`) — insert a `property_members` row for the creator's property in the same tx as the profile + Supabase user creation. New staff currently have no tenant, which blocks per-request resolution.
6. **`/auth/me` returns property context** (`auth.ts:153`, web `AuthContext.tsx:14`) — include `currentPropertyId` + membership list `(id, name, code)`; the client currently has no notion of "which hotel am I in", blocking tenant-scoped cache keys, shell branding, and a property switcher.
7. **Rewrite `apps/api/src/db/seed.ts:46`** — it creates the admin profile but never inserts `user_roles` (so a fresh-DB admin resolves to empty permissions and 403s everywhere) and assumes one global settings row. Route it through the same atomic provisioning helper as signup.
8. **Identity model decision** (`settings.ts:424`) — `profiles.email` is globally unique and Supabase users are platform-global, so staff creation errors "already exists" if the email works at another hotel (leaks that they work elsewhere). Decide: one platform identity per email (attach a new `property_members` row to the existing auth user instead of erroring) OR drop `unique(email)` for per-tenant reuse; at minimum return a non-revealing failure.
9. **Fix the enumeration oracle** (`auth.ts:49`) — `POST /forgot-password/check` openly confirms whether an email is an active staff account ("acceptable for this single-property deployment"). As a public SaaS surface it becomes a cross-tenant staff-email enumeration oracle. Return a constant response shape / generic "if registered you'll receive a link" UX.
10. **Provisioning replaces the migration bootstrap** (`migrations/0013:70`) — migrations stay for PRIMARY; all new tenants provision through code.

---

## 5) Suggested new-baseline schema changes

Per repo hard rules: each change is a NEW numbered SQL file in `apps/api/migrations/` + a Drizzle schema edit + `db/bootstrap/baseline.sql` mirror (note: baseline is scheduled for deletion in §3 Step 4/2 — if it survives, mirror; the CLAUDE.md hard rule is updated by that deletion). **Flag every new migration for deploy** (auto-applies). No destructive drops without explicit human approval.

### A. `property_id` column additions (with backfill → NOT NULL where safe)
| table (schema file) | change |
|---|---|
| `settings` (`db/schema/settings.ts`) | `ADD COLUMN property_id uuid NOT NULL REFERENCES properties(id)` + `UNIQUE`; backfill PRIMARY. (One 1:1 row per property — smaller change than folding into `properties`.) |
| `room_types` (`db/schema/settings.ts:104`) | `ADD COLUMN property_id uuid NOT NULL`; backfill PRIMARY. |
| `message_templates` (`db/schema/messageTemplates.ts`) | `ADD COLUMN property_id uuid NOT NULL`; backfill PRIMARY. |
| `roles` (`db/schema/rbac.ts`) | `ADD COLUMN property_id uuid NULL` (NULL = shared system role). |
| `activity_log` (`db/schema/activity.ts`) | `ADD COLUMN property_id uuid NULL` + index `(property_id, created_at)`; backfill best-effort from entity joins; `lib/activity.ts` stamps it. |
| `maintenance_issues` (`db/schema/maintenance.ts:42`) | backfill `property_id` from `rooms.property_id` then `SET NOT NULL`. |
| `otps` (`db/schema/otps.ts:9`) | `ADD COLUMN property_id uuid NULL`; stamp on send; include in the target/purpose index. |
| `guest_ledger` (`db/schema/guestLedger.ts:12`) | `ADD COLUMN property_id uuid NOT NULL` backfilled from `guests.property_id` (P2 — transitively scoped today). |
| `amenities` (`db/schema/amenities.ts:26`) | `ADD COLUMN property_id uuid NULL` (NULL = shared catalog) for custom rows (P2 — or keep catalog platform-read-only). |
| `notifications` | optional `property_id` for auditing (per `lib/notify.ts`). |
| `idempotency_keys` (`middleware/idempotency.ts:76`) | `ADD COLUMN property_id` + include in `compositeId`. |

### B. New `property_members` table (the tenancy backbone)
```
property_members(
  profile_id  uuid NOT NULL REFERENCES profiles(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  role_id     uuid NOT NULL REFERENCES roles(id),
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, property_id)
)
```
Backfill one row per existing profile → PRIMARY, `role_id` from current `user_roles`. Consider re-keying `user_roles` PK to `(user_id, property_id)` or folding role into `property_members`.

### C. Replace global uniques with composite `(property_id, …)` uniques
| table | drop | add |
|---|---|---|
| `rooms` (`schema/rooms.ts:19`) | global unique on `room_number` | `UNIQUE(property_id, room_number)` |
| `guests` (`schema/guests.ts:74`, migration 0030) | `idx_guests_phone_unique`, `idx_guests_email_unique`, `idx_guests_idproof_unique` | `UNIQUE(property_id, phone)`, `UNIQUE(property_id, LOWER(email)) WHERE email<>''`, `UNIQUE(property_id, id_proof_type, id_proof_last4) WHERE last4<>''` |
| `reservations` (`schema/reservations.ts:22`) | global unique on `reservation_number` | `UNIQUE(property_id, reservation_number)` |
| `invoices` (`schema/invoices.ts:11`) | global unique on `invoice_number` | `UNIQUE(property_id, invoice_number)` |
| `payments` (`schema/invoices.ts:95`) | global unique on `receipt_number` | `UNIQUE(property_id, receipt_number)` |
| `room_types` (`schema/settings.ts:106`) | `unique(slug)` | `UNIQUE(property_id, slug)` |
| `message_templates` (`schema/messageTemplates.ts:22`) | `unique(key)` | `UNIQUE(property_id, key)` |
| `roles` (`schema/rbac.ts:24`) | `unique(key)` | `UNIQUE(COALESCE(property_id,'0000…'), key)` (or partial uniques: one for system NULL-property, one per property) |

### D. New per-hotel counters table (replaces the four global `sldt_*` sequences)
```
property_counters(
  property_id uuid NOT NULL REFERENCES properties(id),
  counter     text NOT NULL,          -- 'reservation' | 'invoice' | 'receipt' | 'credit_note'
  value       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (property_id, counter)
)
```
Allocator: `UPDATE property_counters SET value = value + 1 WHERE property_id=$1 AND counter=$2 RETURNING value` (row-lock serializes, tx-safe like `nextval`). Seed PRIMARY's counters from current `SELECT last_value FROM sldt_reservation_seq/…/sldt_credit_note_seq`. Rewrite the four allocators in `lib/availability.ts:285-318` (move to `numbers.ts`) to take `propertyId + exec`. Leave the historical `sldt_*` sequences (migration 0011:163, 0013:467 `sldt_maintenance_seq`, 0042:30 `sldt_credit_note_seq`) untouched for history; stop reading them; optionally drop once code is clean.

### E. Drop offline tables (see §3 Step 4)
`DROP TABLE sync_outbox, sync_applied_log, sync_devices, message_outbox, local_credentials`; `DROP FUNCTION sync_capture()`; `DROP TRIGGER sync_capture_<table>` ×10; `DROP SEQUENCE sync_change_seq`. Destructive — human approval; run after code removal is deployed.

---

## Summary

**Counts by priority (deduped worklist):**
- **P0 — ~78 items:** 13 cross-cutting infrastructure/singleton fixes + 7 hard schema blockers + ~58 per-route tenancy guards/leaks across reservations, rooms, guests, invoices, payments, ledger, credits, dashboard, reports, calendar, search, expenses, maintenance, housekeeping, amenities, messages, otp, settings, rbac, properties, the 5 resolver caches, the web react-query cache, and the `sync/ingest` write hole. (2 P0 belong to §4 signup: `properties.ts:8`, `migrations/0013:70`.)
- **P1 — ~34 items:** per-hotel numbering (sequences/prefixes/composite uniques), settings threading, storage path namespacing + logo upload, cache re-keying (idempotency, dashboard-invalidate), branding (env→settings, receipt logo fallback, template city suffix, `/auth/me` property context), timezone parameterization, schema `property_id` NOT-NULL hardening, and the `sync/pusher`/ingest-route deletion.
- **P2 — ~45 items:** cosmetic SLDT prefixes in comments, locale/currency hardcodes, per-tenant storage prefixes for expenses/room-images, OTP throttle refinement, `guest_ledger`/`amenities` property columns, login-lockout→Redis, the legacy dual-role cleanup, and the bulk of the offline-legacy file deletions/branch strips (web + api).

**10 most critical items (do first):**
1. `apps/api/src/routes/sync.ts:48` + `lib/sync/ingest.ts` — **live cross-tenant write hole**: device-token-authed whole-row upserts into 10 business tables with any `property_id`, bypassing auth/RBAC/scoping. Delete + revoke `sync_devices` now.
2. `apps/api/src/lib/currentProperty.ts:21` — `resolveCurrentPropertyId()` hardcodes PRIMARY; the single-tenant lynchpin every insert depends on.
3. `apps/api/src/middleware/auth.ts:86` + `db/schema/profiles.ts:4` (+ new `property_members`) — no per-request tenant resolution and no profile→property linkage exist; blocks multi-tenancy entirely.
4. `apps/api/src/routes/reservations.ts:2093` (+ invoice-insert sites) — GST invoices stamped with the PRIMARY hotel's `hotelName`/`hotelGstin` for every tenant → **legally invalid tax documents**.
5. `apps/api/src/db/schema/guests.ts:74` & `rooms.ts:19` — global uniques on guest phone/email/ID and `room_number` make a second hotel's inserts fail (hard blockers + PII existence leak).
6. `apps/api/src/routes/reservations.ts:267` + `guests.ts:88/1075` + `invoices.ts:30/181` + `search.ts:45` — bare-id/list IDOR returning guest PII, KYC ID-proof images, and 5000-row invoice exports across all tenants.
7. `apps/api/src/routes/ledger.ts:16` + `reservations.ts:5237` — cross-tenant **money-out**: cash out another hotel's guest wallet; record/void payments against another hotel's books.
8. `apps/api/src/lib/settings.ts:7` + `db/schema/settings.ts:20` — the settings singleton feeds hotel identity/GST/policy to ~25 sites; every tenant would run on the PRIMARY hotel's config.
9. `apps/api/src/routes/rbac.ts:125/219` (+ `schema/rbac.ts:22`) — an admin can rewrite/delete another hotel's custom roles and assign roles to another hotel's staff (cross-tenant privilege escalation).
10. `apps/web/src/main.tsx:12` — react-query cache never cleared across sign-out/sign-in, serving hotel A's hotel identity/dashboard/guests to hotel B on a shared machine (client-side leak). Plus `migrations/0052` triggers likely live on the cloud DB silently pooling every tenant's writes into `sync_outbox`.

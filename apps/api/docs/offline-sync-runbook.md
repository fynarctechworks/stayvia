# Offline-First Sync — Operator Runbook (Phase 2 & 3)

This is the **operator-executed** procedure for taking the offline desk from
"local only" (Phase 1) to "authoritative desk with a live cloud backup replica"
(Phases 2–3). Every step here touches real infrastructure and must be run by a
human — the code never does any of this autonomously.

**Prerequisite:** Phase 1 is deployed (the desk runs fully offline on embedded
Postgres). Migrations `0050`–`0053` are applied on the relevant databases.

---

## Where each migration runs

| Migration | Desk (embedded PG) | Cloud (Supabase/VPS) |
|---|---|---|
| 0050 local_credentials | ✅ | — |
| 0051 message_outbox | ✅ | — |
| 0052 sync_outbox + capture triggers | ✅ | ❌ (never — the replica must be passive) |
| 0053 sync_applied_log + sync_devices | ❌ | ✅ |

> The capture triggers (0052) must exist ONLY on the desk. If they ever run on
> the cloud replica, the cloud would try to re-capture the upserts it receives.
> Apply 0052 only to the embedded cluster.

---

## Phase 2 — stand up the one-way replica (staging-shadowed)

### 1. Provision a device token (cloud)
```sql
-- On the CLOUD db. Generate a random token, store only its sha256.
INSERT INTO sync_devices (device_id, token_hash, label)
VALUES ('desk-sabbavaram-1', encode(sha256('<the-random-token>'::bytea),'hex'), 'Front desk PC');
```
Put the raw token on the desk as `SYNC_DEVICE_TOKEN`, plus
`SYNC_DEVICE_ID=desk-sabbavaram-1` and `SYNC_INGEST_URL=https://api.sldt.infynarc.com/api/v1/sync/ingest`.
The desk holds ONLY this scoped token — never the Supabase service-role key.

### 2. First-run backfill (operator, online, trusted machine)
Seed the embedded cluster with a faithful copy of prod so the desk starts
authoritative:
```bash
PROD_DATABASE_URL='postgresql://…prod…' \
LOCAL_DATABASE_URL='postgresql://hoteldesk:…@127.0.0.1:5433/hoteldesk' \
node apps/api/scripts/backfill-to-local.mjs --apply
```
- Dry-run first (omit `--apply`) to see the parity report.
- The script refuses a non-loopback `LOCAL_DATABASE_URL`.
- After restore, `setval()` the `sldt_*_seq` sequences to prod's high-water mark
  so the desk continues the existing invoice/receipt numbering (the dump carries
  sequence state; verify with `SELECT last_value FROM sldt_invoice_seq;`).
- **Go/no-go gate:** the script aborts if row counts or `SUM(payments.amount)`
  don't match prod. Do not declare the desk authoritative on a mismatch.

### 3. Shadow phase (mandatory)
Point the pusher at a **staging schema/replica first**, not the prod replica.
Let the desk run for N days. Each night, reconcile desk vs staging:
- row counts per synced table match, and
- `SUM(payments.amount)`, `SUM(guest_ledger.amount)` match.

Only proceed to Phase 3 after the reconciliation is clean for N consecutive
nights. Prod keeps Supabase PITR throughout.

### Money-safety properties (already proven by `scripts/sync-safety-test.mjs`)
- **No lost payment:** money is durable in local Postgres (fsync'd WAL) before
  the pusher ever runs — push is pure backup.
- **No duplicate on replay:** the cloud dedups by `(origin_device_id,
  change_seq)` in `sync_applied_log` (no TTL), so re-pushing after a lost ack —
  even days later — is a guaranteed no-op.
- **No lost void:** changes replicate as **whole-row upserts by UUID**, so an
  edit/void/split (an in-place UPDATE) lands correctly; the replica NEVER
  recomputes.

---

## Phase 3 — go-live cutover

Do this ONLY after the shadow reconciliation has been clean for N nights.

1. **Take a Supabase PITR checkpoint** (safety net you can roll back to).
2. **Freeze cloud money-write routes.** On the VPS API, make the
   reservation/payment/invoice write routes read-only and make the cloud
   sequences read-only. This removes the second writer — the desk becomes the
   sole minter of invoice/receipt numbers. (This is the root-cause fix for every
   sequence-collision / double-spend risk in the rejected designs.)
3. **Flip the pusher target** from the staging schema to the prod replica
   schema.
4. **Delete any time-boxed transition branches** (e.g. code that still accepted
   real Supabase tokens during migration).
5. **Hypercare (1 week):** monitor the pusher/drainer. A deliberately-injected
   un-appliable row must surface a **staff-visible alert**, not a silent FIFO
   stall.

### Rollback
If reconciliation drifts post-cutover: unfreeze cloud money-routes, point the
web app back at the cloud API, restore from the PITR checkpoint if needed. The
desk's local Postgres is untouched by any of this (one-way push), so the desk's
own data is never at risk.

---

## What is NOT yet built (deferred)

- **`api.exe` packaging** (pkg + bundled Chromium): needs a machine with a
  stable Rust/cargo build (this dev box crashes cargo on the `windows` crate
  under parallelism). The Rust lifecycle code (`db_manager.rs`, `sidecar.rs`) is
  written and reviewed; it just needs to compile + package there.
- **Web-side Tauri IPC transport** (token held in Rust, `api.ts` repointed,
  offline PIN-login modal, connectivity banner): coupled to the Tauri build, so
  deferred with `api.exe`. The offline OTP-code reveal UI (`OtpModal.tsx`) is
  done and independent.
- **VPS outbox-send proxy** (`/outbox/send`, Twilio creds on VPS): the desk
  drainer calls it via `setOutboxDeliverer`; the proxy endpoint itself is a
  small VPS route to add when the replica goes live.

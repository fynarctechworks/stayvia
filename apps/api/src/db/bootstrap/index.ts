import postgres from "postgres";

import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { BASELINE_SQL } from "./baseline.js";

// First-run schema bootstrap for the offline sidecar.
//
// A freshly-initdb'd embedded Postgres is empty. drizzle-kit push (which
// normally creates the base tables) needs the CLI + TS schema files and can't
// run inside the pkg-bundled api.exe. So instead we ship a complete
// schema-only baseline (db/bootstrap/baseline.sql, generated from a
// fully-migrated DB) and apply it once. The baseline already reflects every
// numbered migration, so we then stamp all of them as applied — future
// migrations run normally via migrate.mjs.
//
// Gated on SLDT_SCHEMA_BOOTSTRAP=1 (set by the Tauri handshake only when the
// cluster was freshly created). Idempotent: if the schema already exists, it's
// a no-op.

/**
 * If SLDT_SCHEMA_BOOTSTRAP is set and the DB has no app tables, apply the
 * baseline schema. Must run BEFORE the server starts serving. Safe to call
 * unconditionally.
 */
export async function bootstrapSchemaIfNeeded(): Promise<void> {
  if (!env.SLDT_SCHEMA_BOOTSTRAP) return;

  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
  try {
    // Guard: only bootstrap a genuinely empty DB, so a stray flag can't
    // clobber an existing schema.
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'profiles'
    `;
    if ((rows[0]?.n ?? 0) > 0) {
      logger.info("schema bootstrap skipped — profiles table already exists");
      return;
    }

    logger.info("applying baseline schema (first run)…");
    await sql.unsafe(BASELINE_SQL);

    // Stamp every shipped migration as applied — the baseline already includes
    // their effect, so migrate.mjs must not re-run them.
    await stampMigrationsApplied(sql);

    logger.info("baseline schema applied");
  } finally {
    await sql.end();
  }
}


// Insert a schema_migrations row for every migration file name so migrate.mjs
// treats them as done. The baseline was dumped from a DB at migration 0053, so
// we mark 0001..0053 applied.
async function stampMigrationsApplied(sql: postgres.Sql): Promise<void> {
  // schema_migrations is the migration-runner ledger created by migration 0001.
  // The schema-only baseline dump doesn't include it (it's infrastructure, not
  // app schema), so create it here, then stamp every shipped migration as
  // applied so migrate.mjs runs only FUTURE migrations.
  // The baseline dump ends by setting an empty search_path, so schema-qualify
  // everything explicitly (public.*).
  await sql`SET search_path TO public`;
  await sql`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  for (const name of MIGRATION_NAMES) {
    await sql`
      INSERT INTO public.schema_migrations (name) VALUES (${name})
      ON CONFLICT (name) DO NOTHING
    `;
  }
}

// The migration file names through the baseline snapshot. Kept in sync with
// apps/api/migrations/*.sql up to the point the baseline was generated.
const MIGRATION_NAMES = [
  "0001_baseline.sql",
  "0002_guest_ledger_and_photo.sql",
  "0003_wallet_credit_columns.sql",
  "0004_otp_ip_address.sql",
  "0005_idempotency_keys.sql",
  "0006_late_checkout_hours.sql",
  "0007_receipt_a4_default.sql",
  "0008_short_stay.sql",
  "0009_gst_mode.sql",
  "0010_hotel_location.sql",
  "0011_phase1_stabilization.sql",
  "0012_enable_rls_deny_all.sql",
  "0013_phase2_foundation.sql",
  "0014_phase2_revenue_ops.sql",
  "0015_phase3_4_compliance.sql",
  "0016_payments_allow_zero.sql",
  "0017_per_room_checkout.sql",
  "0018_charges_per_room.sql",
  "0019_room_swap_segments.sql",
  "0020_gender_and_co_guests.sql",
  "0021_arrival_reminders.sql",
  "0022_guest_phone_history.sql",
  "0023_planned_times.sql",
  "0024_complimentary_unlock_code.sql",
  "0025_expenses.sql",
  "0026_balance_recompute_backfill.sql",
  "0027_repair_misattached_payments.sql",
  "0028_chronological_payment_attribution.sql",
  "0029_backfill_invoice_scope.sql",
  "0030_guest_uniqueness.sql",
  "0031_backfill_room_invoice_links.sql",
  "0032_maintenance_issues.sql",
  "0033_backfill_room_notes_to_issues.sql",
  "0034_collapse_cleaning_workflow.sql",
  "0035_redistribute_advance_payments.sql",
  "0036_swap_from_room_id.sql",
  "0037_reservation_room_swap_history.sql",
  "0038_segment_aware_stay_range.sql",
  "0039_split_overflowing_payments.sql",
  "0040_frontdesk_perms_expand.sql",
  "0041_payments_allow_negative.sql",
  "0042_credit_notes.sql",
  "0043_extra_bed_charges.sql",
  "0044_frontdesk_view_maintenance_backfill.sql",
  "0045_resolve_maintenance_backfill.sql",
  "0046_housekeeping_manage_maintenance_backfill.sql",
  "0047_frontdesk_daily_collections.sql",
  "0048_original_check_out_date.sql",
  "0049_settings_otp_required_for_checkin.sql",
  "0050_local_credentials.sql",
  "0051_message_outbox.sql",
  "0052_sync_outbox.sql",
  "0053_sync_ingest.sql",
];

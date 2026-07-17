// One-off backfill: align planned_check_out_at with check_out_date for
// reservations whose extend predates the fix (the /extend handler used to
// update check_out_date only, leaving planned_check_out_at stale — which is
// the field the reservation header displays). Rolls the stored time-of-day
// onto check_out_date; only the calendar date moves.
//
// Usage:
//   node scripts/backfill-planned-checkout.mjs            # dry run, all stale
//   node scripts/backfill-planned-checkout.mjs --apply    # apply to all stale
//   node scripts/backfill-planned-checkout.mjs SLDT-RES-0019 --apply
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import postgres from "postgres";

const nodeEnv = process.env.NODE_ENV ?? "development";
for (const f of [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, ".env"]) {
  const p = resolve(process.cwd(), f);
  if (existsSync(p)) dotenv.config({ path: p });
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const only = args.find((a) => !a.startsWith("--")) ?? null;

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const rows = await sql`
    SELECT id, reservation_number, check_out_date, planned_check_out_at
    FROM reservations
    WHERE planned_check_out_at IS NOT NULL
      ${only ? sql`AND reservation_number = ${only}` : sql``}
    ORDER BY reservation_number
  `;

  const stale = [];
  for (const r of rows) {
    // planned date (UTC calendar date of the stored timestamp) vs the
    // authoritative check_out_date. If they differ, it's stale.
    const planned = new Date(r.planned_check_out_at);
    const plannedDate = planned.toISOString().slice(0, 10);
    // The driver returns `date` columns as Date objects; normalize to
    // a YYYY-MM-DD string (UTC) for comparison and splitting.
    const target =
      r.check_out_date instanceof Date
        ? r.check_out_date.toISOString().slice(0, 10)
        : String(r.check_out_date);
    if (plannedDate === target) continue;

    // Roll the time-of-day onto the target date, in UTC, matching how the
    // app stores these timestamptz values.
    const [y, m, d] = target.split("-").map(Number);
    const next = new Date(planned);
    next.setUTCFullYear(y, m - 1, d);

    stale.push({
      id: r.id,
      reservation_number: r.reservation_number,
      from: r.planned_check_out_at,
      to: next.toISOString(),
    });
  }

  if (stale.length === 0) {
    console.log(only ? `No stale planned_check_out_at for ${only}.` : "Nothing to backfill.");
  } else {
    console.log(`${apply ? "Applying" : "[dry run]"} — ${stale.length} reservation(s):`);
    for (const s of stale) {
      console.log(`  ${s.reservation_number}: ${s.from}  ->  ${s.to}`);
    }
    if (apply) {
      for (const s of stale) {
        await sql`
          UPDATE reservations
          SET planned_check_out_at = ${s.to}, updated_at = now()
          WHERE id = ${s.id}
        `;
      }
      console.log("Done.");
    } else {
      console.log("\nRe-run with --apply to write these changes.");
    }
  }
} finally {
  await sql.end();
}

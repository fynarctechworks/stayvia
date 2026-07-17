// First-run backfill: seed a fresh embedded/local Postgres with a faithful,
// FK-complete, sequence-correct copy of production, so the offline desk starts
// authoritative. OPERATOR-RUN, ONLINE, on a TRUSTED machine — never unattended
// on the lobby PC, and the prod connection string is used only here.
//
// Procedure (matches the offline-first spec §5):
//   1. pg_dump prod (data + sequence state), --no-owner --no-privileges
//      --no-acl, public schema only (strips Supabase roles/RLS DDL that would
//      break a restore into the plain local cluster). auth.* is excluded.
//   2. Restore into the freshly-migrated local cluster (same 48 migrations ran
//      first, so the schema matches).
//   3. Verify: row-count parity per table + SUM(payments.amount) checksum.
//      Mismatch => ABORT, do not declare authoritative.
//
// This script orchestrates + verifies; it shells out to pg_dump/psql. It never
// writes to prod (read-only pg_dump) and never runs migrations against prod
// (the DB-target guard blocks that).
//
// Usage:
//   PROD_DATABASE_URL=... LOCAL_DATABASE_URL=... node scripts/backfill-to-local.mjs [--apply]
// Without --apply it does a dry-run parity check only (no restore).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const PROD = process.env.PROD_DATABASE_URL;
const LOCAL = process.env.LOCAL_DATABASE_URL;
const APPLY = process.argv.includes("--apply");

if (!PROD || !LOCAL) {
  console.error("Set PROD_DATABASE_URL and LOCAL_DATABASE_URL");
  process.exit(1);
}
// Safety: LOCAL must be loopback. Never let this restore into a remote DB.
if (!/@(127\.0\.0\.1|localhost|host\.docker\.internal)[:/]/.test(LOCAL)) {
  console.error("LOCAL_DATABASE_URL must be loopback — refusing to restore into a remote DB");
  process.exit(1);
}

// Tables whose row counts + money checksums we verify for parity.
const VERIFY_TABLES = [
  "profiles", "guests", "rooms", "reservations", "reservation_rooms",
  "invoices", "payments", "guest_ledger", "expenses",
];

async function counts(url) {
  const sql = postgres(url, { max: 2, prepare: false });
  try {
    const out = {};
    for (const t of VERIFY_TABLES) {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(t)}`;
      out[t] = n;
    }
    const [{ paysum }] = await sql`SELECT COALESCE(SUM(amount),0)::text AS paysum FROM payments`;
    out.__paysum = paysum;
    return out;
  } finally {
    await sql.end();
  }
}

async function main() {
  console.log(`Backfill ${APPLY ? "(APPLY)" : "(dry-run)"} — prod -> local`);

  if (APPLY) {
    const dir = mkdtempSync(join(tmpdir(), "sldt-backfill-"));
    const dumpFile = join(dir, "prod.sql");
    try {
      console.log("1/3  pg_dump prod (data + sequences, public only)…");
      execFileSync("pg_dump", [
        PROD, "--data-only", "--schema=public",
        "--no-owner", "--no-privileges", "--no-acl",
        "-f", dumpFile,
      ], { stdio: "inherit" });

      console.log("2/3  restore into local…");
      execFileSync("psql", [LOCAL, "-f", dumpFile], { stdio: "inherit" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("3/3  verify parity…");
  const [p, l] = await Promise.all([counts(PROD), counts(LOCAL)]);
  let ok = true;
  for (const k of Object.keys(p)) {
    const match = String(p[k]) === String(l[k] ?? "(missing)");
    if (!match) ok = false;
    console.log(`  ${match ? "OK " : "MISMATCH"} ${k}: prod=${p[k]} local=${l[k] ?? "-"}`);
  }
  if (!ok) {
    console.error("\nPARITY FAILED — do NOT declare the desk authoritative.");
    process.exit(2);
  }
  console.log(`\n${APPLY ? "Backfill complete." : "Dry-run parity clean."} Money checksum matches.`);
}

main().catch((e) => {
  console.error("Backfill error:", e);
  process.exit(1);
});

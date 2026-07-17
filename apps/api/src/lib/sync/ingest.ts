import { sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { logger } from "../logger.js";

// Cloud-side sync ingest (runs on the VPS replica). Applies a batch of desk
// changes with two guarantees:
//   1. IDEMPOTENT — each change is applied in the SAME transaction that records
//      (origin_device_id, change_seq) in sync_applied_log ON CONFLICT DO
//      NOTHING. A replayed batch (lost ack) is a total no-op, forever — no TTL.
//   2. WHOLE-ROW UPSERT — I/U upsert the full row by UUID id; D deletes by id.
//      The replica NEVER recomputes anything (no balance recompute, no receipt
//      minting) — the desk already computed derived columns and they arrive as
//      plain data. This is what prevents lost-voids / double-counted-splits.
//
// Changes MUST be applied in change_seq order (the desk pushes them ordered);
// because a payment's seq follows its parent reservation's, FK constraints are
// satisfied on replay.

export type SyncChange = {
  changeSeq: number;
  tableName: string;
  op: "I" | "U" | "D";
  rowId: string;
  rowData: Record<string, unknown> | null;
};

// Allowlist of tables the ingest will write. Must match the capture set in
// migration 0052. Prevents a compromised/buggy desk from writing arbitrary
// tables on the replica.
const INGESTABLE = new Set([
  "reservations",
  "reservation_rooms",
  "reservation_co_guests",
  "invoices",
  "payments",
  "guests",
  "guest_ledger",
  "expenses",
  "maintenance_issues",
  "housekeeping_tasks",
]);

export type IngestResult = { applied: number; skipped: number };

/**
 * Apply an ordered batch of changes from one device. Returns counts.
 * Applied = changes newly written; skipped = already-seen (dedup).
 */
export async function ingestBatch(
  deviceId: string,
  changes: SyncChange[],
): Promise<IngestResult> {
  let applied = 0;
  let skipped = 0;

  // One tx PER CHANGE so a dedup no-op on change N doesn't roll back the
  // already-applied change N-1. Each change + its applied-log row commit
  // atomically.
  for (const change of changes) {
    if (!INGESTABLE.has(change.tableName)) {
      throw new Error(`refusing to ingest non-syncable table: ${change.tableName}`);
    }
    const didApply = await db.transaction(async (tx) => {
      // Claim the (device, seq) slot first. If it already exists, this change
      // was applied before — skip entirely.
      const claim = await tx.execute(sql`
        INSERT INTO sync_applied_log (origin_device_id, change_seq)
        VALUES (${deviceId}, ${change.changeSeq})
        ON CONFLICT (origin_device_id, change_seq) DO NOTHING
        RETURNING change_seq
      `);
      // drizzle's execute returns rows in .rows for pg
      const claimed = (claim as unknown as { rows?: unknown[] }).rows ?? (claim as unknown[]);
      if (Array.isArray(claimed) && claimed.length === 0) {
        return false; // already applied
      }

      if (change.op === "D") {
        await tx.execute(
          sql`DELETE FROM ${sql.identifier(change.tableName)} WHERE id = ${change.rowId}`,
        );
      } else {
        if (!change.rowData) {
          throw new Error(`I/U change ${change.changeSeq} has no rowData`);
        }
        await upsertRow(tx, change.tableName, change.rowData);
      }
      return true;
    });
    if (didApply) applied++;
    else skipped++;
  }

  logger.info({ deviceId, applied, skipped, total: changes.length }, "sync batch ingested");
  return { applied, skipped };
}

// Whole-row upsert on id. Builds `INSERT ... ON CONFLICT (id) DO UPDATE SET
// col = EXCLUDED.col` from the jsonb keys. The replica trusts the desk's
// values verbatim (including desk-computed derived columns).
async function upsertRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const cols = Object.keys(row);
  if (!cols.includes("id")) throw new Error(`row for ${table} has no id`);

  const colIdents = cols.map((c) => sql.identifier(c));
  const values = cols.map((c) => sql`${jsonValue(row[c])}`);
  const updates = cols
    .filter((c) => c !== "id")
    .map((c) => sql`${sql.identifier(c)} = EXCLUDED.${sql.identifier(c)}`);

  await tx.execute(sql`
    INSERT INTO ${sql.identifier(table)} (${sql.join(colIdents, sql`, `)})
    VALUES (${sql.join(values, sql`, `)})
    ON CONFLICT (id) DO UPDATE SET ${sql.join(updates, sql`, `)}
  `);
}

// Coerce a jsonb-decoded value to a form Postgres accepts as a bound param.
// Objects/arrays go back as jsonb; primitives pass through; undefined -> null.
function jsonValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

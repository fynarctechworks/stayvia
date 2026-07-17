import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import type { DocCounter } from "../db/schema/propertyCounters.js";

type Db = typeof db;
type Exec = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Per-hotel document number allocation. Replaces the legacy global
// Postgres sequences: each hotel owns a row per counter in
// property_counters, created lazily on first use. The atomic upsert
// row-locks, so concurrent allocations within a hotel serialize exactly
// like nextval() did — and a rolled-back tx releases the number instead
// of burning it (fine either way for audit).
//
// Callers MUST pass the tenant explicitly (usually from the parent row
// being billed: reservation.propertyId / invoice.propertyId). There is
// deliberately no global fallback.
export async function nextDocNumber(
  exec: Exec,
  propertyId: string,
  counter: DocCounter,
): Promise<number> {
  const result = await exec.execute<{ value: string | number }>(sql`
    INSERT INTO property_counters (property_id, counter, value)
    VALUES (${propertyId}, ${counter}, 1)
    ON CONFLICT (property_id, counter)
    DO UPDATE SET value = property_counters.value + 1
    RETURNING value
  `);
  const row = result[0] as { value: string | number } | undefined;
  return Number(row?.value ?? 0);
}

const fmt4 = (n: number) => String(n).padStart(4, "0");

export function reservationNumber(seq: number) {
  return `RES-${fmt4(seq)}`;
}

export function invoiceNumber(_prefix: string, seq: number) {
  // _prefix kept for back-compat with callers that pass settings.invoicePrefix
  return `INV-${fmt4(seq)}`;
}

export function receiptNumber(seq: number) {
  return `RCP-${fmt4(seq)}`;
}

export function creditNoteNumber(seq: number) {
  return `CN-${fmt4(seq)}`;
}

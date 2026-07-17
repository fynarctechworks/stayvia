// Quick verification of the balance backfill. Lists every reservation
// whose stored balance_due does not equal the formula:
//   grand_total − Σ(received non-voided payments) − wallet_credit_applied
// Cancelled/no_show are excluded (they're intentional zeros).
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const nodeEnv = process.env.NODE_ENV ?? "development";
for (const f of [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, ".env"]) {
  const p = resolve(API_ROOT, f);
  if (existsSync(p)) dotenv.config({ path: p });
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const drift = await sql`
  WITH paid AS (
    SELECT r.id, COALESCE(SUM(CASE WHEN p.voided=false AND p.status='received' THEN p.amount ELSE 0 END), 0) AS s
    FROM reservations r LEFT JOIN payments p ON p.reservation_id = r.id
    GROUP BY r.id
  )
  SELECT
    r.reservation_number,
    r.status,
    r.grand_total::numeric AS grand_total,
    paid.s AS sum_paid,
    r.wallet_credit_applied::numeric AS wallet,
    r.balance_due::numeric AS stored_balance,
    GREATEST(0, r.grand_total::numeric - paid.s - r.wallet_credit_applied::numeric) AS expected_balance
  FROM reservations r
  JOIN paid ON paid.id = r.id
  WHERE r.status NOT IN ('cancelled','no_show')
    AND ABS(r.balance_due::numeric - GREATEST(0, r.grand_total::numeric - paid.s - r.wallet_credit_applied::numeric)) > 0.01
  ORDER BY r.created_at DESC
`;
console.log(`Drift rows: ${drift.length}`);
for (const d of drift) {
  console.log(d);
}

console.log("\nSLDT-RES-0070 detail:");
const detail = await sql`
  SELECT r.reservation_number, r.status, r.grand_total, r.advance_paid, r.wallet_credit_applied, r.balance_due
  FROM reservations r WHERE r.reservation_number = 'SLDT-RES-0070'
`;
console.log(detail[0]);

console.log("\nSLDT-RES-0070 invoices:");
const invs = await sql`
  SELECT i.id, i.invoice_number, i.status, i.grand_total, i.total_paid, i.balance_due, i.scope
  FROM invoices i
  JOIN reservations r ON r.id = i.reservation_id
  WHERE r.reservation_number = 'SLDT-RES-0070'
  ORDER BY i.created_at
`;
for (const i of invs) console.log(i);

console.log("\nSLDT-RES-0070 payments:");
const pays = await sql`
  SELECT p.receipt_number, p.amount, p.status, p.voided, p.invoice_id, p.notes
  FROM payments p
  JOIN reservations r ON r.id = p.reservation_id
  WHERE r.reservation_number = 'SLDT-RES-0070'
  ORDER BY p.payment_date
`;
for (const p of pays) console.log(p);

console.log("\nSLDT-RES-0073 detail:");
const d73 = await sql`
  SELECT r.reservation_number, r.status, r.grand_total, r.advance_paid, r.wallet_credit_applied, r.balance_due
  FROM reservations r WHERE r.reservation_number = 'SLDT-RES-0073'
`;
console.log(d73[0]);

await sql.end();

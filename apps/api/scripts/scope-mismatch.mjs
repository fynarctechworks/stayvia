import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
for (const f of [".env.development.local", ".env.development", ".env"]) {
  const p = resolve(API_ROOT, f);
  if (existsSync(p)) dotenv.config({ path: p });
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// 1. Reservations with status != 'cancelled'/'no_show' whose
//    grandTotal − Σpayments − wallet differs from stored balance.
const drift = await sql`
  WITH paid AS (
    SELECT r.id, COALESCE(SUM(CASE WHEN p.voided=false AND p.status='received' THEN p.amount ELSE 0 END), 0) AS s
    FROM reservations r LEFT JOIN payments p ON p.reservation_id = r.id GROUP BY r.id
  )
  SELECT r.reservation_number, r.balance_due,
    GREATEST(0, r.grand_total::numeric - paid.s - r.wallet_credit_applied::numeric) AS expected
  FROM reservations r JOIN paid ON paid.id = r.id
  WHERE r.status NOT IN ('cancelled','no_show')
    AND ABS(r.balance_due::numeric - GREATEST(0, r.grand_total::numeric - paid.s - r.wallet_credit_applied::numeric)) > 0.01
`;
console.log(`Reservation balance drift: ${drift.length}`);
for (const d of drift) console.log(`  ${d.reservation_number}: stored ${d.balance_due}, expected ${d.expected}`);

// 2. Invoices whose stored balance != grand − Σreceived − wallet.
const idrift = await sql`
  WITH paid AS (
    SELECT i.id, COALESCE(SUM(CASE WHEN p.voided=false AND p.status='received' THEN p.amount ELSE 0 END), 0) AS s
    FROM invoices i LEFT JOIN payments p ON p.invoice_id = i.id WHERE i.status <> 'voided' GROUP BY i.id
  )
  SELECT i.invoice_number, i.balance_due, i.grand_total, paid.s, i.wallet_credit_applied
  FROM invoices i JOIN paid ON paid.id = i.id
  WHERE ABS(i.balance_due::numeric - GREATEST(0, i.grand_total::numeric - paid.s - i.wallet_credit_applied::numeric)) > 0.01
`;
console.log(`Invoice balance drift: ${idrift.length}`);
for (const d of idrift) console.log(`  ${d.invoice_number}: stored ${d.balance_due}, expected_max(0, ${d.grand_total} - ${d.s} - ${d.wallet_credit_applied})`);

// 3. Orphan payments (no invoice) where the reservation has a non-voided invoice.
const orphans = await sql`
  SELECT p.receipt_number, p.amount, r.reservation_number
  FROM payments p
  JOIN reservations r ON r.id = p.reservation_id
  WHERE p.invoice_id IS NULL AND p.voided = false AND p.status = 'received'
    AND EXISTS (SELECT 1 FROM invoices i WHERE i.reservation_id = r.id AND i.status <> 'voided')
`;
console.log(`Orphan payments on reservations with invoices: ${orphans.length}`);
for (const o of orphans) console.log(`  ${o.receipt_number} ₹${o.amount} on ${o.reservation_number}`);

// 4. Invoices marked combined that actually cover ≤1 room.
const scope = await sql`
  SELECT invoice_number FROM invoices
  WHERE scope='combined' AND (array_length(scope_room_ids,1) <= 1 OR scope_room_ids IS NULL)
`;
console.log(`Combined invoices covering ≤1 room: ${scope.length}`);

// 5. Reservation rooms with NULL invoiceId on a checked_out reservation.
const unbilled = await sql`
  SELECT r.reservation_number, COUNT(*)::int AS n
  FROM reservation_rooms rr
  JOIN reservations r ON r.id = rr.reservation_id
  WHERE r.status = 'checked_out' AND rr.invoice_id IS NULL
  GROUP BY r.reservation_number
`;
console.log(`Checked-out reservations with unlinked rooms (excluding cancelled): ${unbilled.length}`);
for (const u of unbilled) console.log(`  ${u.reservation_number}: ${u.n} room(s) without an invoice link`);

await sql.end();

// One-off repair: SLDT-RES-0070 has two duplicate payment rows
// (RCP-0167 ₹48,000 and RCP-0168 ₹3,496.25) that were manually
// recorded by staff to "fix" the wrong-looking balance the broken
// per-invoice attribution was showing. The real money the guest
// handed over is ₹5,000 (booking) + ₹46,496.25 (forward-credit
// from RES-0069 checkout) = ₹51,496.25 — exactly the grand total.
//
// These two manual entries are voided here with an audit note so
// the balance flips back to ₹0 cleanly. Invoice totals are
// recomputed afterwards from the same formula the application now
// uses going forward.
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

const voidNote =
  "System-voided after balance-recompute (migrations 0026-0028). " +
  "This row was manually recorded by staff to settle a balance that " +
  "the pre-fix per-invoice attribution was reporting incorrectly. " +
  "Actual money received is recorded on RCP-0144 + RCP-0153.";

const result = await sql.begin(async (tx) => {
  // Void the two duplicate manual payments by receipt number.
  const voided = await tx`
    UPDATE payments
    SET voided = true,
        voided_reason = ${voidNote},
        voided_at = NOW()
    WHERE receipt_number IN ('SLDT-RCP-0167', 'SLDT-RCP-0168')
      AND voided = false
    RETURNING receipt_number, amount
  `;

  // Recompute every invoice on RES-0070 from the surviving payments.
  await tx`
    WITH paid AS (
      SELECT
        i.id AS invoice_id,
        COALESCE(SUM(CASE WHEN p.voided = false AND p.status = 'received' THEN p.amount::numeric ELSE 0 END), 0) AS s
      FROM invoices i
      LEFT JOIN payments p ON p.invoice_id = i.id
      WHERE i.reservation_id = (SELECT id FROM reservations WHERE reservation_number = 'SLDT-RES-0070')
        AND i.status <> 'voided'
      GROUP BY i.id
    )
    UPDATE invoices
    SET
      total_paid = ROUND(paid.s + invoices.wallet_credit_applied::numeric, 2),
      balance_due = GREATEST(0, ROUND(invoices.grand_total::numeric - paid.s - invoices.wallet_credit_applied::numeric, 2)),
      status = CASE
        WHEN invoices.grand_total::numeric - paid.s - invoices.wallet_credit_applied::numeric <= 0.009 THEN 'paid'
        WHEN paid.s + invoices.wallet_credit_applied::numeric > 0 THEN 'partial'
        ELSE 'issued'
      END,
      updated_at = NOW()
    FROM paid
    WHERE invoices.id = paid.invoice_id
  `;

  // Recompute the reservation balance from the same facts.
  await tx`
    WITH paid AS (
      SELECT COALESCE(SUM(CASE WHEN p.voided = false AND p.status = 'received' THEN p.amount::numeric ELSE 0 END), 0) AS s
      FROM payments p
      WHERE p.reservation_id = (SELECT id FROM reservations WHERE reservation_number = 'SLDT-RES-0070')
    )
    UPDATE reservations
    SET
      advance_paid = ROUND((SELECT s FROM paid), 2),
      balance_due = GREATEST(0, ROUND(grand_total::numeric - (SELECT s FROM paid) - wallet_credit_applied::numeric, 2)),
      updated_at = NOW()
    WHERE reservation_number = 'SLDT-RES-0070'
  `;

  return voided;
});

console.log("Voided rows:");
for (const v of result) console.log(`  ${v.receipt_number} (₹${v.amount})`);

console.log("\nAfter repair — RES-0070:");
const after = await sql`
  SELECT r.reservation_number, r.status, r.grand_total, r.advance_paid, r.balance_due,
         (SELECT json_agg(json_build_object(
           'invoice_number', i.invoice_number,
           'status', i.status,
           'grand_total', i.grand_total,
           'total_paid', i.total_paid,
           'balance_due', i.balance_due
         ) ORDER BY i.created_at)
          FROM invoices i WHERE i.reservation_id = r.id) AS invs
  FROM reservations r WHERE r.reservation_number = 'SLDT-RES-0070'
`;
console.log(JSON.stringify(after[0], null, 2));

await sql.end();

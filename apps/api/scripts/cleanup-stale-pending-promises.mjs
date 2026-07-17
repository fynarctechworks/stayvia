// One-shot cleanup for pending-promise payments that are no longer real.
// A "pending promise" is a payment row with status='pending' (used when
// staff picks "Unpaid · collect later" at check-out). If the invoice was
// later fully paid via the "collect previous balance" flow OR by manually
// marking it received in a way that didn't clear the promise, the pending
// row lingers and clutters the Collections page.
//
// This script voids every pending promise whose invoice is now `paid` or
// `voided`. The void reason is descriptive so the audit log is clear.
//
// Safe to re-run.
//
//   node scripts/cleanup-stale-pending-promises.mjs

import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  // Find candidates first so we can print what's about to change.
  const candidates = await sql`
    SELECT p.id, p.receipt_number, p.amount, p.invoice_id, i.invoice_number, i.status AS invoice_status
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    WHERE p.status = 'pending'
      AND p.voided = false
      AND i.status IN ('paid', 'voided')
  `;

  if (!candidates.length) {
    console.log("Nothing to clean up. All pending promises are still on open invoices.");
    process.exit(0);
  }

  console.log(`Found ${candidates.length} stale pending-promise(s):`);
  for (const c of candidates) {
    console.log(
      `  ${c.receipt_number}  ₹${c.amount}  → ${c.invoice_number} (${c.invoice_status})`,
    );
  }
  console.log("");

  for (const c of candidates) {
    await sql`
      UPDATE payments
      SET voided = true,
          voided_reason = ${`Auto-voided: invoice ${c.invoice_number} is ${c.invoice_status}; promise no longer applicable`},
          voided_at = NOW()
      WHERE id = ${c.id}
    `;
    console.log(`  voided ${c.receipt_number}`);
  }

  console.log(`\nDone. ${candidates.length} row(s) voided.`);
} finally {
  await sql.end();
}

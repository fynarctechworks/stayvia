import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const r = await sql`
    SELECT id, reservation_number, status, grand_total, advance_paid, balance_due
    FROM reservations
    WHERE reservation_number = 'SLDT-RES-0005'
  `;
  console.log("RESERVATION:");
  console.log(r);

  if (!r.length) process.exit(0);
  const rid = r[0].id;

  const inv = await sql`
    SELECT id, invoice_number, status, grand_total, total_paid, balance_due, wallet_credit_applied
    FROM invoices WHERE reservation_id = ${rid}
  `;
  console.log("\nINVOICES:");
  console.log(inv);

  const pays = await sql`
    SELECT id, receipt_number, amount, payment_method, status, voided, notes, payment_date
    FROM payments WHERE reservation_id = ${rid}
    ORDER BY payment_date
  `;
  console.log("\nPAYMENTS:");
  console.log(pays);
} finally {
  await sql.end();
}

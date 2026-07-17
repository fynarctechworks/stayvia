import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const guests = await sql`SELECT id, full_name FROM guests`;
  for (const g of guests) {
    console.log(`\n=== ${g.full_name} (${g.id}) ===`);
    const res = await sql`
      SELECT reservation_number, status, grand_total, advance_paid, balance_due
      FROM reservations WHERE guest_id = ${g.id}
    `;
    console.log("Reservations:", res);
    const inv = await sql`
      SELECT invoice_number, status, grand_total, total_paid, balance_due
      FROM invoices WHERE guest_id = ${g.id}
    `;
    console.log("Invoices:", inv);
    const pays = await sql`
      SELECT p.amount, p.payment_method, p.status, p.invoice_id, r.reservation_number
      FROM payments p
      LEFT JOIN reservations r ON r.id = p.reservation_id
      WHERE r.guest_id = ${g.id}
    `;
    console.log("Payments:", pays);
  }
} finally {
  await sql.end();
}

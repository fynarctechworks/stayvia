import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const g = await sql`SELECT id, full_name FROM guests WHERE full_name ILIKE '%greesh%' LIMIT 1`;
  if (!g.length) {
    console.log("no guest");
    process.exit(0);
  }
  const gid = g[0].id;
  console.log("guest:", g[0]);

  const r = await sql`
    SELECT id, reservation_number, status, grand_total, advance_paid, balance_due, created_at
    FROM reservations
    WHERE guest_id = ${gid}
    ORDER BY created_at DESC
  `;
  console.log("\nRESERVATIONS:");
  console.log(r);

  const inv = await sql`
    SELECT id, invoice_number, reservation_id, status, grand_total, total_paid, balance_due
    FROM invoices
    WHERE guest_id = ${gid}
    ORDER BY created_at DESC
  `;
  console.log("\nINVOICES:");
  console.log(inv);
} finally {
  await sql.end();
}

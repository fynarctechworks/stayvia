import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const inv = await sql`SELECT i.id, i.invoice_number, i.reservation_id, r.reservation_number FROM invoices i JOIN reservations r ON r.id = i.reservation_id WHERE r.reservation_number = 'SLDT-RES-0010'`;
  console.log(inv);
} finally { await sql.end(); }

import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const li = await sql`SELECT description FROM invoice_line_items WHERE item_type='room_charge' ORDER BY created_at DESC LIMIT 5`;
  console.log(li);
} finally {
  await sql.end();
}

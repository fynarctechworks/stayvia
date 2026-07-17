import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const rows = await sql`
    SELECT reservation_number, guest_id, status, check_in_date, check_out_date, created_at
    FROM reservations
    ORDER BY created_at DESC
  `;
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await sql.end();
}

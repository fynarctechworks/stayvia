import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);
try {
  await sql`ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_photo text`;
  console.log("ok: guest_photo column ensured");
} catch (e) {
  console.error("migration failed:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}

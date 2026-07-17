import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

async function main() {
  console.log("Adding receipt support to payments...");

  await sql`ALTER TABLE payments ALTER COLUMN invoice_id DROP NOT NULL`;
  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_number text`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receipt_number ON payments(receipt_number) WHERE receipt_number IS NOT NULL`;

  console.log("Done.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

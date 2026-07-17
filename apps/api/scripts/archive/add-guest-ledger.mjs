import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);
try {
  await sql`
    CREATE TABLE IF NOT EXISTS guest_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      entry_type text NOT NULL CHECK (entry_type IN ('credit_issued','credit_used','cashout','adjustment')),
      amount numeric(10,2) NOT NULL,
      reservation_id uuid,
      invoice_id uuid,
      payment_id uuid,
      note text,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_guest_ledger_guest ON guest_ledger(guest_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_guest_ledger_created ON guest_ledger(created_at)`;
  console.log("ok: guest_ledger ensured");
} catch (e) {
  console.error("failed:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}

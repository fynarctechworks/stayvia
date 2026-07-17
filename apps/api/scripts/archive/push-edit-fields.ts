import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

async function main() {
  console.log("Adding edit/void columns...");

  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_reason text`;
  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_by uuid`;
  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_at timestamptz`;

  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes text`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_date date`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reissued_from uuid REFERENCES invoices(id)`;

  console.log("Done.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

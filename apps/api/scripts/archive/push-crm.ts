import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

async function main() {
  console.log("Adding tags column + CRM tables...");

  await sql`ALTER TABLE guests ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[]`;

  await sql`
    CREATE TABLE IF NOT EXISTS guest_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      body text NOT NULL,
      author_id uuid,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_guest_notes_guest ON guest_notes(guest_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS guest_follow_ups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      task text NOT NULL,
      due_date date NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      assigned_to uuid,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      completed_at timestamptz
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_guest_followups_guest ON guest_follow_ups(guest_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_guest_followups_status_due ON guest_follow_ups(status, due_date)`;

  console.log("Done.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

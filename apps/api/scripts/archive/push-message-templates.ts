import "dotenv/config";
import postgres from "postgres";

const SQL = `
create table if not exists message_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  subject text,
  body text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { prepare: false });
  console.log("Creating message_templates table...");
  await sql.unsafe(SQL);
  console.log("✓ done");
  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

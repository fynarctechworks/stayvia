import "dotenv/config";
import postgres from "postgres";

const SQL = `
alter table settings
  add column if not exists owner_phone text,
  add column if not exists owner_notify_enabled boolean not null default true;
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { prepare: false });
  console.log("Adding owner_phone + owner_notify_enabled...");
  await sql.unsafe(SQL);
  console.log("✓ done");
  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

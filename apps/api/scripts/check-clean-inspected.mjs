// Audit any rooms currently sitting in clean / inspected status —
// we're collapsing the cleaning workflow so those statuses are going
// away. Anything found will be migrated to 'available' in 0034.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
for (const f of [".env.development.local", ".env.development", ".env"]) {
  const p = resolve(API_ROOT, f);
  if (existsSync(p)) dotenv.config({ path: p });
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const rows = await sql`
  SELECT room_number, status FROM rooms
  WHERE status IN ('clean', 'inspected')
  ORDER BY status, room_number
`;
console.log(`Rooms in clean/inspected: ${rows.length}`);
for (const r of rows) console.log(`  ${r.room_number} — ${r.status}`);

await sql.end();

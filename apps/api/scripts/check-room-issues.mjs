// Quick check — does room 201 actually have any maintenance_issues
// rows in the new table, and what's in its legacy notes field?
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

console.log("=== Room 201 — legacy notes field ===");
const rooms = await sql`SELECT id, room_number, notes, status FROM rooms WHERE room_number = '201'`;
console.log(rooms[0]);

console.log("\n=== Room 201 — maintenance_issues rows ===");
const issues = await sql`
  SELECT mi.id, mi.title, mi.category, mi.severity, mi.status, mi.reported_at
  FROM maintenance_issues mi
  JOIN rooms r ON r.id = mi.room_id
  WHERE r.room_number = '201'
`;
console.log(`Found: ${issues.length}`);
for (const i of issues) console.log(i);

console.log("\n=== ALL legacy notes across rooms ===");
const allNotes = await sql`SELECT room_number, notes FROM rooms WHERE notes IS NOT NULL`;
for (const r of allNotes) console.log(`  ${r.room_number}: ${r.notes}`);

await sql.end();

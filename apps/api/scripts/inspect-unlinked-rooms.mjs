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

for (const num of ['SLDT-RES-0039','SLDT-RES-0041','SLDT-RES-0043']) {
  console.log(`\n=== ${num} ===`);
  const r = await sql`SELECT id, status, booking_source, grand_total, balance_due FROM reservations WHERE reservation_number = ${num}`;
  console.log("res:", r[0]);
  const rr = await sql`SELECT room_id, status, invoice_id, checked_out_at FROM reservation_rooms WHERE reservation_id = ${r[0].id}`;
  console.log("reservation_rooms:");
  for (const x of rr) console.log("  ", x);
  const invs = await sql`SELECT invoice_number, status, scope, scope_room_ids FROM invoices WHERE reservation_id = ${r[0].id}`;
  console.log("invoices:");
  for (const x of invs) console.log("  ", x);
}
await sql.end();

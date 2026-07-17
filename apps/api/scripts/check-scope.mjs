import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
for (const f of ['.env.development.local', '.env.development', '.env']) {
  const p = resolve(API_ROOT, f);
  if (existsSync(p)) dotenv.config({ path: p });
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// Invoices tagged "combined" but actually cover just 1 room
const mislabeled = await sql`
  SELECT i.invoice_number, i.scope, array_length(i.scope_room_ids, 1) AS room_count
  FROM invoices i
  WHERE i.scope = 'combined'
    AND (array_length(i.scope_room_ids, 1) <= 1 OR i.scope_room_ids IS NULL)
  ORDER BY i.created_at DESC
`;
console.log(`Mislabeled "combined" invoices (actually 1-room): ${mislabeled.length}`);
for (const m of mislabeled) console.log(`  ${m.invoice_number} scope=${m.scope} rooms=${m.room_count}`);
await sql.end();

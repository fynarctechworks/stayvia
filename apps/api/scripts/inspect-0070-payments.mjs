import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const nodeEnv = process.env.NODE_ENV ?? "development";
for (const f of [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, ".env"]) {
  const p = resolve(API_ROOT, f);
  if (existsSync(p)) dotenv.config({ path: p });
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("All payments tied to RES-0070 (including voided):");
const all = await sql`
  SELECT
    p.receipt_number,
    p.amount,
    p.status,
    p.voided,
    p.invoice_id,
    p.notes,
    p.payment_date,
    p.created_at
  FROM payments p
  JOIN reservations r ON r.id = p.reservation_id
  WHERE r.reservation_number = 'SLDT-RES-0070'
  ORDER BY p.created_at
`;
for (const p of all) console.log(p);

await sql.end();

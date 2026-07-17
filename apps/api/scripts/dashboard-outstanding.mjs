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

const rows = await sql`
  SELECT
    r.reservation_number,
    r.status,
    r.balance_due AS res_balance,
    r.balance_due::numeric AS contributes
  FROM reservations r
  WHERE r.booking_source <> 'complimentary'
    AND r.status <> 'cancelled'
`;
let total = 0;
for (const r of rows) {
  if (Number(r.contributes) !== 0) console.log(r);
  total += Number(r.contributes);
}
console.log(`Dashboard outstanding = ₹${total.toFixed(2)}`);

console.log("\nRES-0070 invoices ordered by created_at:");
const ords = await sql`
  SELECT i.invoice_number, i.created_at, i.balance_due, i.status
  FROM invoices i JOIN reservations r ON r.id = i.reservation_id
  WHERE r.reservation_number = 'SLDT-RES-0070'
  ORDER BY i.created_at
`;
for (const o of ords) console.log(o);

await sql.end();

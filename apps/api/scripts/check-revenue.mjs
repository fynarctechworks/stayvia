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

const today = new Date().toISOString().slice(0, 10);
const startOfMonth = today.slice(0, 8) + '01';

const todayRev = await sql`
  SELECT COALESCE(SUM(p.amount), 0) AS total
  FROM payments p
  INNER JOIN reservations r ON r.id = p.reservation_id
  WHERE p.payment_date >= ${today}::date
    AND p.voided = false
    AND p.status = 'received'
    AND r.booking_source <> 'complimentary'
`;

const mtdRev = await sql`
  SELECT COALESCE(SUM(p.amount), 0) AS total
  FROM payments p
  INNER JOIN reservations r ON r.id = p.reservation_id
  WHERE p.payment_date >= ${startOfMonth}::date
    AND p.voided = false
    AND p.status = 'received'
    AND r.booking_source <> 'complimentary'
`;

console.log(`Today (${today}): ₹${todayRev[0].total}`);
console.log(`MTD   (${startOfMonth}–): ₹${mtdRev[0].total}`);

await sql.end();

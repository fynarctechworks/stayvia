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

console.log("=== Per-invoice stored vs actual ===");
const rows = await sql`
  SELECT
    i.invoice_number,
    i.grand_total::numeric AS grand,
    i.total_paid::numeric AS stored_paid,
    i.balance_due::numeric AS stored_balance,
    i.wallet_credit_applied::numeric AS wallet,
    (SELECT COALESCE(SUM(p.amount::numeric), 0)
     FROM payments p
     WHERE p.invoice_id = i.id AND p.voided = false AND p.status = 'received') AS actual_received_sum,
    (SELECT COUNT(*) FROM payments p
     WHERE p.invoice_id = i.id AND p.voided = false AND p.status = 'received') AS payment_count
  FROM invoices i
  WHERE i.status <> 'voided'
  ORDER BY i.created_at
`;
for (const r of rows) {
  const computed = Number(r.actual_received_sum) + Number(r.wallet);
  const driftPaid = Number(r.stored_paid) - computed;
  const expectedBalance = Math.max(0, Number(r.grand) - computed);
  const tag = Math.abs(driftPaid) > 0.01 ? " ❌ DRIFT" : "";
  console.log(
    `${r.invoice_number} grand=${r.grand} stored_paid=${r.stored_paid} computed=${computed.toFixed(2)} drift=${driftPaid.toFixed(2)} stored_bal=${r.stored_balance} expected_bal=${expectedBalance.toFixed(2)}${tag}`,
  );
}

await sql.end();

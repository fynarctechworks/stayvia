// Pre-migration audit. Finds duplicate emails and duplicate (id_type,
// id_last4) pairs across existing guests so we can decide whether to
// merge / fix them before adding the unique indexes.
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

console.log("=== Duplicate non-null emails ===");
const dupEmails = await sql`
  SELECT lower(email) AS email, array_agg(full_name) AS guests, count(*) AS n
  FROM guests
  WHERE email IS NOT NULL AND email <> ''
  GROUP BY lower(email)
  HAVING count(*) > 1
`;
console.log(`Found: ${dupEmails.length}`);
for (const e of dupEmails) console.log(`  ${e.email} -> ${e.guests.join(", ")}`);

console.log("\n=== Duplicate (id_type, id_last4) pairs ===");
const dupIds = await sql`
  SELECT id_proof_type AS type, id_proof_last4 AS last4,
         array_agg(full_name) AS guests, count(*) AS n
  FROM guests
  WHERE id_proof_last4 IS NOT NULL AND id_proof_last4 <> ''
  GROUP BY id_proof_type, id_proof_last4
  HAVING count(*) > 1
`;
console.log(`Found: ${dupIds.length}`);
for (const i of dupIds) console.log(`  ${i.type}/${i.last4} -> ${i.guests.join(", ")}`);

await sql.end();

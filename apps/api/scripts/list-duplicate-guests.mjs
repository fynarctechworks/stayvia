// Lists every guest involved in a duplicate email / ID / phone group
// plus the basics needed to decide which to keep and which to delete.
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

async function withStays(guestId) {
  const [bk, oc, cg] = await Promise.all([
    sql`SELECT COUNT(*)::int AS n FROM reservations WHERE guest_id = ${guestId}`,
    sql`SELECT COUNT(*)::int AS n FROM reservation_rooms WHERE guest_id = ${guestId}`,
    sql`SELECT COUNT(*)::int AS n FROM reservation_co_guests WHERE guest_id = ${guestId}`,
  ]);
  return (bk[0]?.n ?? 0) + (oc[0]?.n ?? 0) + (cg[0]?.n ?? 0);
}

function fmt(g, stays) {
  return [
    `    id          : ${g.id}`,
    `    name        : ${g.full_name}`,
    `    phone       : ${g.phone}`,
    `    email       : ${g.email ?? "—"}`,
    `    id proof    : ${g.id_proof_type} (last4: ${g.id_proof_last4 ?? "—"})`,
    `    city        : ${g.city ?? "—"}`,
    `    created     : ${g.created_at?.toISOString().slice(0, 16).replace("T", " ")}`,
    `    stays count : ${stays}  ${stays > 0 ? "← has bookings" : "← safe to delete"}`,
  ].join("\n");
}

console.log("=========================================================");
console.log("DUPLICATE GROUP 1 — same email: fynarctechworks@gmail.com");
console.log("=========================================================");
const emailDups = await sql`
  SELECT id, full_name, phone, email, id_proof_type, id_proof_last4, city, created_at
  FROM guests
  WHERE LOWER(email) = LOWER('fynarctechworks@gmail.com')
  ORDER BY created_at
`;
for (let i = 0; i < emailDups.length; i++) {
  const g = emailDups[i];
  const stays = await withStays(g.id);
  console.log(`\n  Guest ${i + 1}:`);
  console.log(fmt(g, stays));
}

console.log("\n=========================================================");
console.log("DUPLICATE GROUP 2 — same Aadhaar last4: 5432");
console.log("=========================================================");
const idDups = await sql`
  SELECT id, full_name, phone, email, id_proof_type, id_proof_last4, city, created_at
  FROM guests
  WHERE id_proof_type = 'aadhaar' AND id_proof_last4 = '5432'
  ORDER BY created_at
`;
for (let i = 0; i < idDups.length; i++) {
  const g = idDups[i];
  const stays = await withStays(g.id);
  console.log(`\n  Guest ${i + 1}:`);
  console.log(fmt(g, stays));
}

await sql.end();

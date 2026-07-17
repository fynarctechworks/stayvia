import "dotenv/config";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { prepare: false });

  console.log("Existing booking_source values:");
  const before = await sql`select booking_source, count(*)::int as n from reservations group by booking_source order by booking_source`;
  console.log(before);

  console.log("\nMigrating: direct/ota → phone_whatsapp, credit → walkin");
  await sql`update reservations set booking_source = 'phone_whatsapp' where booking_source in ('direct', 'ota')`;
  await sql`update reservations set booking_source = 'walkin' where booking_source = 'credit'`;
  await sql`update reservations set booking_source = 'walkin' where booking_source not in ('walkin', 'phone_whatsapp', 'complimentary')`;

  console.log("\nAfter:");
  const after = await sql`select booking_source, count(*)::int as n from reservations group by booking_source order by booking_source`;
  console.log(after);

  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

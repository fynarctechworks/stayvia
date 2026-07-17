import "dotenv/config";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { prepare: false });
  const rooms = await sql`select id, room_number, status, room_type from rooms order by room_number`;
  console.log("Rooms:");
  for (const r of rooms) console.log(`  ${r.room_number}: ${r.status} (${r.room_type})`);

  console.log("\nLive reservations (occupying rooms today):");
  const live = await sql`
    select r.reservation_number, r.status,
           to_char(r.check_in_date, 'YYYY-MM-DD') as ci,
           to_char(r.check_out_date, 'YYYY-MM-DD') as co,
           array_agg(rm.room_number) as rooms
    from reservations r
    join reservation_rooms rr on rr.reservation_id = r.id
    join rooms rm on rm.id = rr.room_id
    where r.status in ('confirmed', 'checked_in')
    group by r.id
  `;
  for (const r of live) console.log(`  ${r.reservation_number} (${r.status}) ${r.ci} → ${r.co}: rooms ${r.rooms}`);

  await sql.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

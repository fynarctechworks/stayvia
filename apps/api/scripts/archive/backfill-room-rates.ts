import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

const before = await sql`
  SELECT room_number, room_type, base_rate, max_occupancy
  FROM rooms ORDER BY room_number
`;
console.log("BEFORE:");
console.table(before);

const updated = await sql`
  UPDATE rooms r
  SET base_rate = rt.default_rate,
      max_occupancy = rt.max_occupancy::int,
      updated_at = NOW()
  FROM room_types rt
  WHERE rt.slug = r.room_type
  RETURNING r.room_number, r.room_type, r.base_rate, r.max_occupancy
`;
console.log("AFTER:");
console.table(updated);

await sql.end();

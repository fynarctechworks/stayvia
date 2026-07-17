import "dotenv/config";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { prepare: false });

  const profile = await sql`select id, full_name, email, role, is_active from profiles where email = 'admin@hoteldesk.local'`;
  if (!profile.length) {
    console.log("No Hotel Owner profile found.");
    await sql.end();
    process.exit(0);
  }
  const id = profile[0]!.id;
  console.log("Profile:", profile[0]);

  const counts = await sql`
    select
      coalesce((select count(*) from reservations where created_by = ${id} or checked_in_by = ${id} or checked_out_by = ${id}), 0)::int as res_count,
      coalesce((select count(*) from invoices where issued_by = ${id} or voided_by = ${id}), 0)::int as inv_count,
      coalesce((select count(*) from payments where received_by = ${id}), 0)::int as pay_count,
      coalesce((select count(*) from activity_log where performed_by = ${id}), 0)::int as act_count
  `;
  console.log("References:", counts[0]);

  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

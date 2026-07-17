import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dbUrl || !supaUrl || !serviceKey) throw new Error("Missing env");

  const sql = postgres(dbUrl, { prepare: false });
  const supa = createClient(supaUrl, serviceKey, { auth: { persistSession: false } });

  const oldOwner = await sql`select id from profiles where email = 'admin@hoteldesk.local' limit 1`;
  if (!oldOwner.length) {
    console.log("Hotel Owner already gone.");
    await sql.end();
    process.exit(0);
  }
  const oldId = oldOwner[0]!.id as string;

  const newOwner = await sql`select id, full_name from profiles where email = 'sldt@sldtstayinn.com' limit 1`;
  if (!newOwner.length) throw new Error("SLDT Admin (sldt@sldtstayinn.com) not found.");
  const newId = newOwner[0]!.id as string;

  console.log(`Reassigning references from ${oldId} → ${newId} (${newOwner[0]!.full_name})...`);

  await sql.begin(async (tx) => {
    await tx`update reservations set created_by = ${newId} where created_by = ${oldId}`;
    await tx`update reservations set checked_in_by = ${newId} where checked_in_by = ${oldId}`;
    await tx`update reservations set checked_out_by = ${newId} where checked_out_by = ${oldId}`;
    await tx`update invoices set issued_by = ${newId} where issued_by = ${oldId}`;
    await tx`update invoices set voided_by = ${newId} where voided_by = ${oldId}`;
    await tx`update payments set received_by = ${newId} where received_by = ${oldId}`;
    await tx`update activity_log set performed_by = ${newId} where performed_by = ${oldId}`;

    if (await tx`select to_regclass('public.guest_notes') as t`.then((r) => r[0]?.t)) {
      await tx`update guest_notes set author_id = ${newId} where author_id = ${oldId}`;
    }
    if (await tx`select to_regclass('public.guest_follow_ups') as t`.then((r) => r[0]?.t)) {
      await tx`update guest_follow_ups set assigned_to = ${newId} where assigned_to = ${oldId}`;
      await tx`update guest_follow_ups set created_by = ${newId} where created_by = ${oldId}`;
    }
    if (await tx`select to_regclass('public.guests') as t`.then((r) => r[0]?.t)) {
      await tx`update guests set kyc_verified_by = ${newId} where kyc_verified_by = ${oldId}`;
    }

    if (await tx`select to_regclass('public.notifications') as t`.then((r) => r[0]?.t)) {
      await tx`delete from notifications where recipient_id = ${oldId}`;
    }
    if (await tx`select to_regclass('public.messages') as t`.then((r) => r[0]?.t)) {
      await tx`delete from messages where sender_id = ${oldId} or recipient_id = ${oldId}`;
    }

    await tx`delete from profiles where id = ${oldId}`;
  });

  console.log("Profile row deleted. Removing from Supabase Auth...");
  const { error } = await supa.auth.admin.deleteUser(oldId);
  if (error) {
    console.error("Auth delete failed:", error.message);
    process.exit(1);
  }
  console.log("✓ Hotel Owner removed.");
  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

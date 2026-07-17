import { env } from "../config/env.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { db } from "./client.js";
import { profiles, settings } from "./schema/index.js";

async function main() {
  // Block accidental seeding of a remote (prod) DB from a dev machine.
  // @ts-expect-error — plain JS guard helper, no type declaration needed.
  const { assertLocalDbTarget } = await import("../../scripts/guard-db-target.mjs");
  assertLocalDbTarget(process.env.DATABASE_URL);

  console.log("Seeding HotelDesk (bare minimum: settings row + admin user)...");

  const existingSettings = await db.select().from(settings).limit(1);
  if (existingSettings.length === 0) {
    await db.insert(settings).values({
      hotelName: "My Hotel",
      hotelAddress: "",
      hotelPhone: "",
      hotelEmail: env.SEED_ADMIN_EMAIL,
      hotelGstin: "",
    });
    console.log("\u2713 settings row created (edit from Settings page)");
  } else {
    console.log("\u2022 settings already exist, skipping");
  }

  const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
  const existing = existingUsers?.users.find((u) => u.email === env.SEED_ADMIN_EMAIL);

  let userId: string;
  if (existing) {
    userId = existing.id;
    console.log(`\u2022 admin user already exists: ${env.SEED_ADMIN_EMAIL}`);
  } else {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: env.SEED_ADMIN_EMAIL,
      password: env.SEED_ADMIN_PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("createUser returned no user");
    userId = data.user.id;
    console.log(`\u2713 admin user created: ${env.SEED_ADMIN_EMAIL}`);
  }

  await db
    .insert(profiles)
    .values({
      id: userId,
      fullName: env.SEED_ADMIN_NAME,
      email: env.SEED_ADMIN_EMAIL,
      role: "admin",
      isActive: true,
    })
    .onConflictDoNothing({ target: profiles.id });
  console.log("\u2713 admin profile row ready");

  console.log("\nSeed complete. Everything else (rooms, room-type defaults, charge templates, guests, reservations) starts empty.");
  console.log(`Admin login: ${env.SEED_ADMIN_EMAIL} / ${env.SEED_ADMIN_PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

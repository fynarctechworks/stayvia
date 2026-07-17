import { eq } from "drizzle-orm";

import { env } from "../config/env.js";
import { provisionAdmin, provisionProperty } from "../lib/provisionProperty.js";
import { seedRbacCatalog } from "../lib/rbacCatalog.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { db } from "./client.js";
import { profiles, properties, subscriptions } from "./schema/index.js";

async function main() {
  // Block accidental seeding of a remote (prod) DB from a dev machine.
  // @ts-expect-error — plain JS guard helper, no type declaration needed.
  const { assertLocalDbTarget } = await import("../../scripts/guard-db-target.mjs");
  assertLocalDbTarget(process.env.DATABASE_URL);

  console.log("Seeding Stayvia (RBAC catalog + one hotel + admin user + trial subscription)...");

  // 1. Permission catalog + shared system roles (idempotent).
  await seedRbacCatalog();
  console.log("✓ RBAC catalog seeded");

  // 2. Supabase Auth user for the admin.
  const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
  const existing = existingUsers?.users.find((u) => u.email === env.SEED_ADMIN_EMAIL);

  let userId: string;
  if (existing) {
    userId = existing.id;
    console.log(`• admin user already exists: ${env.SEED_ADMIN_EMAIL}`);
  } else {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: env.SEED_ADMIN_EMAIL,
      password: env.SEED_ADMIN_PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("createUser returned no user");
    userId = data.user.id;
    console.log(`✓ admin user created: ${env.SEED_ADMIN_EMAIL}`);
  }

  // 3. Hotel + settings + admin profile + role + trialing subscription —
  //    the same provisioning path the public signup route uses.
  const [existingProfile] = await db
    .select({ propertyId: profiles.propertyId })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  let propertyId: string;
  if (existingProfile?.propertyId) {
    propertyId = existingProfile.propertyId;
    console.log("• hotel already provisioned, skipping");
  } else {
    const existingProperties = await db.select({ id: properties.id }).from(properties).limit(1);
    if (existingProperties.length > 0) {
      // A hotel exists but this admin isn't wired to it — attach rather
      // than provisioning a second hotel in a dev database.
      propertyId = existingProperties[0]!.id;
      console.log("• attaching admin to the existing hotel");
    } else {
      const provisioned = await db.transaction(async (tx) => provisionProperty(tx, { name: "My Hotel" }));
      propertyId = provisioned.propertyId;
      console.log("✓ hotel provisioned (edit details from Settings)");
    }
    await db.transaction(async (tx) =>
      provisionAdmin(tx, {
        propertyId,
        profileId: userId,
        fullName: env.SEED_ADMIN_NAME,
        email: env.SEED_ADMIN_EMAIL,
      }),
    );
    console.log("✓ admin profile + role assignment ready");
  }

  // 4. Trialing subscription (idempotent via the property unique). Same
  //    shape the public signup route inserts.
  await db
    .insert(subscriptions)
    .values({
      propertyId,
      plan: "standard",
      status: "trialing",
      trialEndsAt: new Date(Date.now() + env.TRIAL_DAYS * 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing({ target: subscriptions.propertyId });
  console.log(`✓ trialing subscription (${env.TRIAL_DAYS} days)`);

  console.log("\nSeed complete. Rooms, room types, templates, guests, reservations start empty.");
  console.log(`Admin login: ${env.SEED_ADMIN_EMAIL} / ${env.SEED_ADMIN_PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

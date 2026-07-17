import { randomBytes } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { profiles } from "../db/schema/profiles.js";
import { properties } from "../db/schema/properties.js";
import { userRoles, roles } from "../db/schema/rbac.js";
import { settings } from "../db/schema/settings.js";

type Db = typeof db;
type Exec = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Hotel provisioning — the single path that creates a tenant. Used by
// db:seed today and the public signup route (Phase 3). Deliberately
// minimal: one properties row + its settings defaults row. Rooms, room
// types, templates etc. start empty and are configured through the app.

function generateCode(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${slug || "hotel"}-${randomBytes(3).toString("hex")}`;
}

export async function provisionProperty(
  tx: Exec,
  input: { name: string; timezone?: string },
): Promise<{ propertyId: string }> {
  const [property] = await tx
    .insert(properties)
    .values({
      code: generateCode(input.name),
      name: input.name,
      timezone: input.timezone ?? "Asia/Kolkata",
    })
    .returning({ id: properties.id });
  const propertyId = property!.id;

  // Settings defaults — required NOT NULL text columns start empty and
  // are filled in from the Settings page / onboarding wizard.
  await tx.insert(settings).values({
    propertyId,
    hotelName: input.name,
    hotelAddress: "",
    hotelPhone: "",
    hotelGstin: "",
  });

  return { propertyId };
}

// Creates the owner/admin staff account for a hotel: the profiles row
// (same UUID as the Supabase Auth user) + the user_roles assignment to
// the shared system admin role. Call seedRbacCatalog() once beforehand
// (idempotent) so the role exists.
export async function provisionAdmin(
  tx: Exec,
  input: {
    propertyId: string;
    profileId: string;
    fullName: string;
    email: string;
    phone?: string | null;
  },
): Promise<void> {
  await tx
    .insert(profiles)
    .values({
      id: input.profileId,
      fullName: input.fullName,
      email: input.email,
      role: "admin",
      isActive: true,
      phone: input.phone ?? null,
      propertyId: input.propertyId,
    })
    .onConflictDoNothing({ target: profiles.id });

  const [adminRole] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.key, "admin"), isNull(roles.propertyId)))
    .limit(1);
  if (!adminRole) {
    throw new Error("System admin role missing — run seedRbacCatalog() before provisionAdmin()");
  }

  await tx
    .insert(userRoles)
    .values({ userId: input.profileId, roleId: adminRole.id })
    .onConflictDoNothing({ target: userRoles.userId });
}

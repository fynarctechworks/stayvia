import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { env } from "../../config/env.js";
import { db } from "../client.js";
import { hashSecret } from "../../lib/localAuth.js";
import { logger } from "../../lib/logger.js";
import { PERMISSION_CATALOG, SYSTEM_ROLES } from "../../lib/permissions.js";
import { localCredentials } from "../schema/localCredentials.js";
import { profiles } from "../schema/profiles.js";
import { PRIMARY_PROPERTY_CODE, properties } from "../schema/properties.js";
import { permissions, rolePermissions, roles, userRoles } from "../schema/rbac.js";
import { settings } from "../schema/settings.js";

// Ensure a fresh offline desk has an admin to log in with. A brand-new
// embedded cluster has zero profiles, so without this there's no way in. We
// create ONE admin with a default PIN the operator must change on first login.
//
// Idempotent: if any profile already exists, this is a no-op (a backfilled or
// previously-seeded desk keeps its real users).
//
// Defaults come from env (SEED_ADMIN_EMAIL/NAME + a fixed first-run PIN); the
// operator is expected to change the PIN immediately via Settings.
const DEFAULT_PIN = "424242";

export async function ensureOfflineAdmin(): Promise<void> {
  // A settings row is mandatory — getSettings() throws (and crashes callers
  // like the dashboard) without one. The schema-only baseline has none, so
  // seed a default. Idempotent.
  await ensureSettingsRow();

  // The single "PRIMARY" property row is mandatory too — every property-scoped
  // write (create room/reservation/guest/expense/maintenance) resolves it via
  // resolveCurrentPropertyId(), which THROWS if it's missing. That throw is
  // uncaught (no asyncHandler/express-async-errors) → unhandled rejection →
  // the sidecar dies. Migration 0013 seeds it in the cloud but is stamped-not-
  // run offline, so seed it here from the settings row. Idempotent.
  await ensurePrimaryProperty();

  // Seed the permission catalog + system roles EVERY boot (idempotently), not
  // only on a fresh DB — so roles/permissions added in code later (e.g. the
  // owner/manager/accountant personas) appear on an already-seeded desk too.
  // The schema-only baseline carries NO reference data and the numbered
  // migrations (which seed RBAC in the cloud) are stamped-applied without
  // running offline, so without this RBAC is empty, isGodMode is false, and
  // every permission-gated endpoint (dashboard, reservations, ...) 403s.
  const adminRoleId = await seedRbacCatalog();

  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(profiles);
  if ((rows[0]?.n ?? 0) > 0) {
    logger.info("offline admin seed skipped — profiles already exist");
    return;
  }

  const id = randomUUID();
  const email = env.SEED_ADMIN_EMAIL;
  const fullName = env.SEED_ADMIN_NAME;

  await db.insert(profiles).values({
    id,
    email,
    fullName,
    role: "admin",
    isActive: true,
  });
  await db
    .insert(localCredentials)
    .values({ profileId: id, pinHash: hashSecret(DEFAULT_PIN) })
    .onConflictDoUpdate({
      target: localCredentials.profileId,
      set: { pinHash: hashSecret(DEFAULT_PIN), updatedAt: new Date() },
    });

  // Assign the fresh admin user to the admin role (which carries "*").
  if (adminRoleId) {
    await db
      .insert(userRoles)
      .values({ userId: id, roleId: adminRoleId })
      .onConflictDoUpdate({ target: userRoles.userId, set: { roleId: adminRoleId } });
  }

  logger.warn(
    { email, pin: DEFAULT_PIN },
    "seeded first-run offline admin — CHANGE THE PIN on first login",
  );
}

// Populate the permission catalog + system roles. Idempotent — safe to run on
// every boot so roles/permissions added in code appear on existing desks.
// Returns the admin role id so the caller can assign a freshly-seeded admin.
async function seedRbacCatalog(): Promise<string | null> {
  // 1. Permissions catalog + the "*" god-mode sentinel (role_permissions FKs
  //    to permissions.key, so "*" must exist as a row).
  const permRows = [
    { key: "*", area: "System", label: "All permissions (god mode)", description: null as string | null },
    ...PERMISSION_CATALOG.map((p) => ({
      key: p.key,
      area: p.area,
      label: p.label,
      description: null as string | null,
    })),
  ];
  await db.insert(permissions).values(permRows).onConflictDoNothing();

  // 2. System roles (admin/frontdesk/housekeeping), and remember the admin id.
  let adminRoleId: string | null = null;
  for (const def of Object.values(SYSTEM_ROLES)) {
    const roleId = randomUUID();
    await db
      .insert(roles)
      .values({
        id: roleId,
        key: def.key,
        label: def.label,
        description: def.description,
        isSystem: true,
      })
      .onConflictDoNothing({ target: roles.key });

    // Resolve the actual id (ours if freshly inserted, else the existing one).
    const [row] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, def.key))
      .limit(1);
    const rid = row?.id ?? roleId;
    if (def.key === "admin") adminRoleId = rid;

    // 3. role_permissions for this role.
    const rp = def.permissions.map((permissionKey) => ({ roleId: rid, permissionKey }));
    if (rp.length) await db.insert(rolePermissions).values(rp).onConflictDoNothing();
  }

  return adminRoleId;
}

// Seed the single settings row (the app assumes exactly one). Most columns
// have schema defaults; we set only the identity fields. No-op if one exists.
async function ensureSettingsRow(): Promise<void> {
  const existing = await db.select({ n: sql<number>`count(*)::int` }).from(settings);
  if ((existing[0]?.n ?? 0) > 0) return;
  await db.insert(settings).values({
    hotelName: env.HOTEL_DISPLAY_NAME,
    hotelAddress: "",
    hotelPhone: "",
    hotelEmail: env.SEED_ADMIN_EMAIL,
    hotelGstin: "",
  });
  logger.info("seeded default settings row (offline first run)");
}

// Seed the single "PRIMARY" property row, derived from the settings row —
// exactly as migration 0013 does in the cloud. Every operational table FKs
// property_id to this, and resolveCurrentPropertyId() throws without it, so a
// fresh desk that skips this crashes on its first property-scoped write.
// Must run AFTER ensureSettingsRow(). No-op if a property already exists.
async function ensurePrimaryProperty(): Promise<void> {
  const existing = await db.select({ n: sql<number>`count(*)::int` }).from(properties);
  if ((existing[0]?.n ?? 0) > 0) return;

  const [s] = await db
    .select({
      hotelName: settings.hotelName,
      hotelAddress: settings.hotelAddress,
      hotelPhone: settings.hotelPhone,
      hotelEmail: settings.hotelEmail,
      hotelGstin: settings.hotelGstin,
      hotelLatitude: settings.hotelLatitude,
      hotelLongitude: settings.hotelLongitude,
      checkInTime: settings.checkInTime,
      checkOutTime: settings.checkOutTime,
    })
    .from(settings)
    .limit(1);

  await db
    .insert(properties)
    .values({
      code: PRIMARY_PROPERTY_CODE,
      name: s?.hotelName || env.HOTEL_DISPLAY_NAME,
      address: s?.hotelAddress || null,
      phone: s?.hotelPhone || null,
      email: s?.hotelEmail || null,
      gstin: s?.hotelGstin || null,
      latitude: s?.hotelLatitude ?? null,
      longitude: s?.hotelLongitude ?? null,
      // settings uses time columns ("HH:MM:SS"); properties wants "HH:MM".
      defaultCheckInTime: (s?.checkInTime ?? "12:00").slice(0, 5),
      defaultCheckOutTime: (s?.checkOutTime ?? "11:00").slice(0, 5),
    })
    .onConflictDoNothing({ target: properties.code });
  logger.info("seeded PRIMARY property row (offline first run)");
}

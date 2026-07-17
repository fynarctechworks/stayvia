import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { permissions, rolePermissions, roles } from "../db/schema/rbac.js";
import { PERMISSION_CATALOG, SYSTEM_ROLES } from "./permissions.js";

// Populate the permission catalog + system roles. Idempotent — safe to run
// repeatedly so roles/permissions added in code appear on existing databases.
// Returns the admin role id so the caller can assign a freshly-seeded admin.
export async function seedRbacCatalog(): Promise<string | null> {
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

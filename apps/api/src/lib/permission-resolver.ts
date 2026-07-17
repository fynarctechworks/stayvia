import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  rolePermissions,
  roles,
  userPermissionOverrides,
  userRoles,
} from "../db/schema/rbac.js";

// Resolves a user's effective permission set:
//   1. Start with the role's permissions (or "*" sentinel for admin → all keys)
//   2. Apply per-user overrides: "deny" removes, "grant" adds
// Returns a Set<string> with concrete permission keys (no "*" — expanded).
//
// Cost: 3 small queries. For a single-property hotel this runs once per request
// in requireAuth — well below noise. If we ever need to scale, add a per-user
// in-memory cache keyed by userId with bust-on-write semantics.
export async function getUserPermissions(userId: string): Promise<{
  permissions: Set<string>;
  roleKey: string | null;
  isGodMode: boolean;
}> {
  const userRoleRows = await db
    .select({ roleId: userRoles.roleId, roleKey: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId))
    .limit(1);

  if (!userRoleRows.length) {
    return { permissions: new Set(), roleKey: null, isGodMode: false };
  }
  const { roleId, roleKey } = userRoleRows[0]!;

  const rolePerms = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));

  // Admin shortcut: role has "*" → god mode.
  if (rolePerms.some((p) => p.key === "*")) {
    return { permissions: new Set(["*"]), roleKey, isGodMode: true };
  }

  const set = new Set(rolePerms.map((p) => p.key));

  const overrides = await db
    .select({ key: userPermissionOverrides.permissionKey, effect: userPermissionOverrides.effect })
    .from(userPermissionOverrides)
    .where(eq(userPermissionOverrides.userId, userId));

  for (const o of overrides) {
    if (o.effect === "grant") set.add(o.key);
    else if (o.effect === "deny") set.delete(o.key);
  }

  return { permissions: set, roleKey, isGodMode: false };
}

// Convenience: does the user have a permission?
// Accepts the resolved set (so callers that already have it don't re-query).
export function hasPermission(
  userPerms: { permissions: Set<string>; isGodMode: boolean },
  key: string,
): boolean {
  if (userPerms.isGodMode) return true;
  return userPerms.permissions.has(key);
}

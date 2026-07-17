import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { profiles } from "../db/schema/profiles.js";
import {
  rolePermissions,
  roles,
  userPermissionOverrides,
  userRoles,
} from "../db/schema/rbac.js";
import { logActivity } from "../lib/activity.js";
// Static import — permission-resolver.ts pulls only db/schema, no cycle.
// Dynamic import() fails inside the pkg-bundled sidecar.
import { getUserPermissions } from "../lib/permission-resolver.js";
import { PERMISSION_CATALOG } from "../lib/permissions.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// --- Permissions catalog (read-only) ---
router.get("/permissions", requireAuth, async (_req, res) => {
  // Return the static catalog (excludes the "*" sentinel) — UI doesn't need to render
  // god-mode as a checkbox, since admin role is locked.
  return ok(res, PERMISSION_CATALOG);
});

// A role is visible to a hotel if it's a shared system role (propertyId
// NULL) or one of the hotel's own custom roles. Other hotels' roles read
// as 404 everywhere below.
function visibleRoles(propertyId: string) {
  return or(isNull(roles.propertyId), eq(roles.propertyId, propertyId));
}

// --- Roles ---
router.get("/roles", requireAuth, async (req, res) => {
  const rows = await db
    .select()
    .from(roles)
    .where(visibleRoles(req.propertyId))
    .orderBy(asc(roles.label));
  // Attach permission keys per role (only the visible ones).
  const roleIds = rows.map((r) => r.id);
  const allPerms = roleIds.length
    ? await db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds))
    : [];
  const byRole = new Map<string, string[]>();
  for (const rp of allPerms) {
    if (!byRole.has(rp.roleId)) byRole.set(rp.roleId, []);
    byRole.get(rp.roleId)!.push(rp.permissionKey);
  }
  const enriched = rows.map((r) => ({
    ...r,
    permissions: byRole.get(r.id) ?? [],
  }));
  return ok(res, enriched);
});

router.get("/roles/:id", requireAuth, async (req, res) => {
  const id = req.params.id!;
  const role = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, id), visibleRoles(req.propertyId)))
    .limit(1);
  if (!role.length) return fail(res, 404, "NOT_FOUND", "Role not found");
  const perms = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, id));
  return ok(res, { ...role[0], permissions: perms.map((p) => p.key) });
});

const roleCreateSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9_]+$/, "key must be lowercase letters, digits, underscores"),
  label: z.string().min(2).max(80),
  description: z.string().max(500).optional().nullable(),
  permissions: z.array(z.string()).default([]),
});

router.post(
  "/roles",
  requireAuth,
  requirePermission("manage_roles"),
  validate(roleCreateSchema),
  async (req, res) => {
    const input = req.body as z.infer<typeof roleCreateSchema>;

    if (input.key === "admin") {
      return fail(res, 400, "RESERVED", "Role key 'admin' is reserved");
    }

    // Key collision within THIS hotel's namespace: its own custom roles
    // plus the shared system roles (a custom role shadowing 'frontdesk'
    // would be ambiguous in the UI). Other hotels' keys don't collide.
    const existing = await db
      .select()
      .from(roles)
      .where(and(eq(roles.key, input.key), visibleRoles(req.propertyId)))
      .limit(1);
    if (existing.length) {
      return fail(res, 409, "DUPLICATE", "A role with that key already exists");
    }

    // Filter out invalid permission keys (not in catalog) and the "*" sentinel.
    const validKeys = new Set(PERMISSION_CATALOG.map((p) => p.key));
    const cleanPerms = input.permissions.filter((k) => validKeys.has(k));

    const [created] = await db
      .insert(roles)
      .values({
        key: input.key,
        label: input.label,
        description: input.description ?? null,
        isSystem: false,
        // Custom roles belong to the hotel that created them.
        propertyId: req.propertyId,
      })
      .returning();

    if (cleanPerms.length) {
      await db.insert(rolePermissions).values(
        cleanPerms.map((k) => ({ roleId: created!.id, permissionKey: k })),
      );
    }

    await logActivity({
      propertyId: req.propertyId,
      action: "role_created",
      entityType: "role",
      entityId: created!.id,
      description: `Role "${created!.label}" created with ${cleanPerms.length} permissions`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    return ok(res, { ...created, permissions: cleanPerms }, 201);
  },
);

const roleUpdateSchema = z.object({
  label: z.string().min(2).max(80).optional(),
  description: z.string().max(500).optional().nullable(),
  permissions: z.array(z.string()).optional(),
});

router.patch(
  "/roles/:id",
  requireAuth,
  requirePermission("manage_roles"),
  validate(roleUpdateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as z.infer<typeof roleUpdateSchema>;

    // Another hotel's role reads as 404 — its existence is not confirmed.
    const role = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, id), visibleRoles(req.propertyId)))
      .limit(1);
    if (!role.length) return fail(res, 404, "NOT_FOUND", "Role not found");

    // System roles (admin/frontdesk/housekeeping) are shared across every
    // hotel — editing one would change another tenant's permissions.
    if (role[0]!.isSystem || role[0]!.propertyId === null) {
      return fail(res, 403, "LOCKED", "System roles cannot be edited");
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.label !== undefined) patch.label = input.label;
    if (input.description !== undefined) patch.description = input.description;
    await db.update(roles).set(patch).where(eq(roles.id, id));

    if (input.permissions !== undefined) {
      const validKeys = new Set(PERMISSION_CATALOG.map((p) => p.key));
      const cleanPerms = input.permissions.filter((k) => validKeys.has(k));
      // Replace strategy: simpler than diffing.
      await db.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      if (cleanPerms.length) {
        await db.insert(rolePermissions).values(
          cleanPerms.map((k) => ({ roleId: id, permissionKey: k })),
        );
      }
    }

    await logActivity({
      propertyId: req.propertyId,
      action: "role_updated",
      entityType: "role",
      entityId: id,
      description: `Role "${role[0]!.label}" updated`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    return ok(res, { success: true });
  },
);

router.delete(
  "/roles/:id",
  requireAuth,
  requirePermission("manage_roles"),
  async (req, res) => {
    const id = req.params.id!;
    // Another hotel's role reads as 404 — its existence is not confirmed.
    const role = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, id), visibleRoles(req.propertyId)))
      .limit(1);
    if (!role.length) return fail(res, 404, "NOT_FOUND", "Role not found");
    if (role[0]!.isSystem || role[0]!.propertyId === null) {
      return fail(res, 403, "LOCKED", "System roles cannot be deleted");
    }

    // Block deletion if any users still hold this role.
    const usingRole = await db
      .select({ id: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.roleId, id))
      .limit(1);
    if (usingRole.length) {
      return fail(
        res,
        409,
        "IN_USE",
        "Reassign users currently in this role before deleting",
      );
    }

    await db.delete(roles).where(eq(roles.id, id));

    await logActivity({
      propertyId: req.propertyId,
      action: "role_deleted",
      entityType: "role",
      entityId: id,
      description: `Role "${role[0]!.label}" deleted`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    return ok(res, { success: true });
  },
);

// --- Per-user role assignment ---
const setUserRoleSchema = z.object({
  roleId: z.string().uuid(),
});

router.put(
  "/users/:userId/role",
  requireAuth,
  requirePermission("manage_staff", "manage_roles"),
  validate(setUserRoleSchema),
  async (req, res) => {
    const userId = req.params.userId!;
    const { roleId } = req.body as { roleId: string };

    // Target must be staff of the caller's hotel; another hotel's user
    // (and role) reads as 404.
    const u = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, userId), eq(profiles.propertyId, req.propertyId)))
      .limit(1);
    if (!u.length) return fail(res, 404, "NOT_FOUND", "User not found");

    const r = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, roleId), visibleRoles(req.propertyId)))
      .limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Role not found");

    // Prevent self-demotion from admin to avoid lockout.
    if (req.user!.id === userId && req.user!.role === "admin" && r[0]!.key !== "admin") {
      return fail(res, 400, "SELF_LOCKOUT", "Admins cannot demote themselves");
    }

    // Upsert user_roles
    await db
      .insert(userRoles)
      .values({ userId, roleId, assignedBy: req.user!.id })
      .onConflictDoUpdate({
        target: userRoles.userId,
        set: { roleId, assignedAt: new Date(), assignedBy: req.user!.id },
      });

    // Keep legacy profiles.role in sync. System role keys map 1:1; for custom
    // roles we fall back to 'frontdesk' so the legacy column never claims
    // 'admin' for a non-admin user. The RBAC tables remain the source of truth
    // for permissions; profiles.role is now purely for legacy display/UI.
    const legacyRole: "admin" | "frontdesk" | "housekeeping" =
      r[0]!.key === "admin"
        ? "admin"
        : r[0]!.key === "housekeeping"
          ? "housekeeping"
          : "frontdesk";
    await db
      .update(profiles)
      .set({ role: legacyRole, updatedAt: new Date() })
      .where(eq(profiles.id, userId));

    await logActivity({
      propertyId: req.propertyId,
      action: "user_role_assigned",
      entityType: "user",
      entityId: userId,
      description: `Role "${r[0]!.label}" assigned to ${u[0]!.fullName}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    return ok(res, { success: true });
  },
);

// --- Per-user permission overrides ---
router.get(
  "/users/:userId/overrides",
  requireAuth,
  requirePermission("manage_staff", "manage_roles"),
  async (req, res) => {
    const userId = req.params.userId!;
    const u = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.id, userId), eq(profiles.propertyId, req.propertyId)))
      .limit(1);
    if (!u.length) return fail(res, 404, "NOT_FOUND", "User not found");
    const rows = await db
      .select()
      .from(userPermissionOverrides)
      .where(eq(userPermissionOverrides.userId, userId));
    return ok(res, rows);
  },
);

const overridesSchema = z.object({
  overrides: z.array(
    z.object({
      permissionKey: z.string(),
      effect: z.enum(["grant", "deny"]),
    }),
  ),
});

router.put(
  "/users/:userId/overrides",
  requireAuth,
  requirePermission("manage_staff", "manage_roles"),
  validate(overridesSchema),
  async (req, res) => {
    const userId = req.params.userId!;
    const { overrides } = req.body as z.infer<typeof overridesSchema>;

    const u = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, userId), eq(profiles.propertyId, req.propertyId)))
      .limit(1);
    if (!u.length) return fail(res, 404, "NOT_FOUND", "User not found");

    const validKeys = new Set(PERMISSION_CATALOG.map((p) => p.key));
    const clean = overrides.filter((o) => validKeys.has(o.permissionKey));

    // Replace all overrides for this user.
    await db.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, userId));
    if (clean.length) {
      await db.insert(userPermissionOverrides).values(
        clean.map((o) => ({
          userId,
          permissionKey: o.permissionKey,
          effect: o.effect,
          createdBy: req.user!.id,
        })),
      );
    }

    await logActivity({
      propertyId: req.propertyId,
      action: "user_overrides_updated",
      entityType: "user",
      entityId: userId,
      description: `Permission overrides updated for ${u[0]!.fullName} (${clean.length} entries)`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    return ok(res, { success: true, count: clean.length });
  },
);

// --- Effective permissions (debug / display) ---
router.get(
  "/users/:userId/effective",
  requireAuth,
  requirePermission("manage_staff", "manage_roles"),
  async (req, res) => {
    const userId = req.params.userId!;
    const u = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.id, userId), eq(profiles.propertyId, req.propertyId)))
      .limit(1);
    if (!u.length) return fail(res, 404, "NOT_FOUND", "User not found");
    const r = await getUserPermissions(userId);
    return ok(res, {
      roleKey: r.roleKey,
      isGodMode: r.isGodMode,
      permissions: Array.from(r.permissions),
    });
  },
);

export default router;

import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { profiles } from "./profiles.js";

// Catalog of permission keys. Code-managed (seeded), not user-creatable.
export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  area: text("area").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Roles. System roles (admin/frontdesk/housekeeping) are seeded with isSystem=true.
// Custom roles can be created by admins; system roles cannot be deleted.
export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Many-to-many: which permissions each role has.
// Admin role has a special "*" row indicating "all permissions" (god mode).
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permissionKey] }),
  }),
);

// Each user has exactly one role (single-role model + per-user overrides).
// Stored as a separate table (not a column on profiles) so the FK to roles is clean
// and we can attach metadata like assignedAt/assignedBy without bloating profiles.
export const userRoles = pgTable("user_roles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => profiles.id, { onDelete: "cascade" }),
  roleId: uuid("role_id")
    .notNull()
    .references(() => roles.id, { onDelete: "restrict" }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  assignedBy: uuid("assigned_by"),
});

// Per-user grant/deny overrides on top of the role's permissions.
// effect = "grant" adds a permission the role doesn't have.
// effect = "deny"  removes a permission the role would otherwise grant.
// Resolution: deny wins over grant; grant wins over role default.
export const userPermissionOverrides = pgTable(
  "user_permission_overrides",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
    effect: text("effect", { enum: ["grant", "deny"] as const }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.permissionKey] }),
  }),
);

export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
export type RbacRole = typeof roles.$inferSelect;
export type NewRbacRole = typeof roles.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type UserRole = typeof userRoles.$inferSelect;
export type UserPermissionOverride = typeof userPermissionOverrides.$inferSelect;

// Special permission key meaning "all permissions". Granted only to the admin role.
export const PERMISSION_ALL = "*" as const;

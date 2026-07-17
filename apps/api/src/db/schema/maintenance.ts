import { sql } from "drizzle-orm";
import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { profiles } from "./profiles.js";
import { rooms } from "./rooms.js";

export const MAINTENANCE_CATEGORIES = [
  "electrical",
  "plumbing",
  "ac_hvac",
  "furniture",
  "fixtures",
  "appliances",
  "cleanliness",
  "safety",
  "structural",
  "other",
] as const;
export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number];

export const MAINTENANCE_SEVERITIES = ["low", "normal", "urgent"] as const;
export type MaintenanceSeverity = (typeof MAINTENANCE_SEVERITIES)[number];

export const MAINTENANCE_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "cancelled",
] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export const maintenanceIssues = pgTable(
  "maintenance_issues",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid("property_id"),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),

    category: text("category", { enum: MAINTENANCE_CATEGORIES }).notNull(),
    severity: text("severity", { enum: MAINTENANCE_SEVERITIES })
      .notNull()
      .default("normal"),
    title: text("title").notNull(),
    description: text("description"),

    status: text("status", { enum: MAINTENANCE_STATUSES })
      .notNull()
      .default("open"),

    reportedBy: uuid("reported_by")
      .notNull()
      .references(() => profiles.id),
    reportedAt: timestamp("reported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    assignedTo: uuid("assigned_to").references(() => profiles.id),
    resolvedBy: uuid("resolved_by").references(() => profiles.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNotes: text("resolution_notes"),

    costEstimate: numeric("cost_estimate", { precision: 10, scale: 2 }),
    costActual: numeric("cost_actual", { precision: 10, scale: 2 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    roomReported: index("idx_maint_room_reported").on(t.roomId, t.reportedAt),
    statusSeverity: index("idx_maint_status_severity").on(t.status, t.severity),
  }),
);

export const maintenanceIssueComments = pgTable(
  "maintenance_issue_comments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => maintenanceIssues.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => profiles.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    issueIdx: index("idx_maint_comments_issue").on(t.issueId, t.createdAt),
  }),
);

export type MaintenanceIssue = typeof maintenanceIssues.$inferSelect;
export type MaintenanceIssueComment = typeof maintenanceIssueComments.$inferSelect;

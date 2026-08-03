import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { profiles } from "./profiles.js";
import { properties } from "./properties.js";
import { reservations } from "./reservations.js";
import { rooms } from "./rooms.js";

// housekeeping_tasks — the task queue from the 0001 baseline.
//
// NO MIGRATION ACCOMPANIES THIS FILE: the table, its two Postgres enum types
// and its indexes have existed since the baseline. This is a Drizzle mapping
// of an existing table, added because POST /guest-requests/:id/convert
// {target:"housekeeping"} needs a typed insert and the alternative was raw SQL
// in the route.
//
// Read this before building on it: until the guest-requests convert landed,
// this table had ZERO code references anywhere in the repo. The live
// housekeeping surface is the rooms.status board (dirty → available) in
// routes/housekeeping.ts, which reads nothing from here. So a row written here
// is currently visible only through the guest_requests row that links to it
// (guest_requests.housekeeping_task_id) plus the notification the convert
// dispatches. A real housekeeping-tasks page is still owed.
//
// The columns below are the baseline's, verbatim. `priority` carries a
// CHECK (priority >= 0 AND priority <= 100) in Postgres that Drizzle cannot
// express — anything writing it must stay inside that range.
//
// Tenancy: property_id is NOT NULL. Every query against this table filters by
// it, including the ones that already know the room.
export const HOUSEKEEPING_TASK_TYPES = [
  "checkout_clean",
  "daily_refresh",
  "deep_clean",
  "inspection",
  "maintenance_followup",
  "custom",
] as const;
export type HousekeepingTaskType = (typeof HOUSEKEEPING_TASK_TYPES)[number];

export const HOUSEKEEPING_TASK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "skipped",
] as const;
export type HousekeepingTaskStatus = (typeof HOUSEKEEPING_TASK_STATUSES)[number];

export const housekeepingTasks = pgTable(
  "housekeeping_tasks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    reservationId: uuid("reservation_id").references(() => reservations.id, {
      onDelete: "set null",
    }),

    taskType: text("task_type", { enum: HOUSEKEEPING_TASK_TYPES })
      .notNull()
      .default("checkout_clean"),
    status: text("status", { enum: HOUSEKEEPING_TASK_STATUSES }).notNull().default("pending"),
    // 0..100, CHECK-constrained in the DB. 50 is the baseline default.
    priority: integer("priority").notNull().default(50),

    assignedTo: uuid("assigned_to").references(() => profiles.id, { onDelete: "set null" }),
    assignedBy: uuid("assigned_by").references(() => profiles.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => profiles.id, { onDelete: "set null" }),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
  },
  (t) => ({
    // Mirrors the baseline's indexes so drizzle-kit never sees them as drift.
    // (idx_housekeeping_tasks_open is partial — Drizzle can't express the
    // WHERE, and it is not needed for type-safety, so it is not modelled.)
    room: index("idx_housekeeping_tasks_room").on(t.roomId, t.createdAt),
    assignee: index("idx_housekeeping_tasks_assignee").on(t.assignedTo, t.status),
  }),
);

export type HousekeepingTask = typeof housekeepingTasks.$inferSelect;
export type NewHousekeepingTask = typeof housekeepingTasks.$inferInsert;

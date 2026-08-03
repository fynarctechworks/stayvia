import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { GUEST_REQUEST_KINDS, GUEST_REQUEST_STATUSES } from "./enums.js";
import { guests } from "./guests.js";
import { housekeepingTasks } from "./housekeeping.js";
import { maintenanceIssues } from "./maintenance.js";
import { profiles } from "./profiles.js";
import { properties } from "./properties.js";
import { reservations } from "./reservations.js";
import { rooms } from "./rooms.js";

// In-room QR guest requests — see migration 0015 for the rationale and the
// index strategy. A guest request is a guest *communication* with its own
// lifecycle, not a work order; staff promote it into the real modules and the
// conversion is recorded on the row itself.
//
// NOT the same thing as "Booking Requests" (/requests), which is QR
// self-booking holds on `reservations`.
//
// Tenancy: propertyId is NOT NULL and leads every index. There is no correct
// query against this table that omits it.
export const guestRequests = pgTable(
  "guest_requests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    // Nullable so service history outlives the stay it came from — a DPDP
    // purge of the guest/reservation must not erase the hotel's record that
    // room 204 asked for towels.
    reservationId: uuid("reservation_id").references(() => reservations.id, {
      onDelete: "set null",
    }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "set null" }),

    kind: text("kind", { enum: GUEST_REQUEST_KINDS }).notNull(),
    status: text("status", { enum: GUEST_REQUEST_STATUSES }).notNull().default("open"),
    // The guest's own wording, verbatim. Optional — tapping the tile is
    // itself the message.
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: uuid("acknowledged_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    // Stamps BOTH terminal states (done and cancelled); status says which.
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => profiles.id, { onDelete: "set null" }),

    // Conversion links. Set exactly once — convert with
    // `WHERE id = ? AND property_id = ? AND <link> IS NULL` and the operation
    // is idempotent; the partial uniques below backstop a race.
    //
    // The `cleaning` conversion target. housekeeping_tasks got its Drizzle
    // model when the convert endpoint landed (db/schema/housekeeping.ts —
    // a mapping of the existing baseline table, no migration), so this now
    // carries the real reference instead of a bare uuid. The FK itself has
    // existed in Postgres since 0015.
    housekeepingTaskId: uuid("housekeeping_task_id").references(() => housekeepingTasks.id, {
      onDelete: "set null",
    }),
    // The live maintenance module — routes/maintenance.ts + MaintenanceDetail.
    // This is the one an `issue` conversion should write.
    maintenanceIssueId: uuid("maintenance_issue_id").references(() => maintenanceIssues.id, {
      onDelete: "set null",
    }),
    // Reserved for the dormant Phase-2 maintenance_tickets module (no Drizzle
    // model, no ticket_number counter yet). FK in SQL only.
    maintenanceTicketId: uuid("maintenance_ticket_id"),
  },
  (t) => ({
    queue: index("idx_guest_requests_queue").on(t.propertyId, t.status, t.createdAt),
    room: index("idx_guest_requests_room").on(t.propertyId, t.roomId, t.createdAt),
    reservation: index("idx_guest_requests_reservation").on(
      t.propertyId,
      t.reservationId,
      t.createdAt,
    ),
    housekeepingTaskUnique: uniqueIndex("uq_guest_requests_housekeeping_task").on(
      t.housekeepingTaskId,
    ),
    maintenanceIssueUnique: uniqueIndex("uq_guest_requests_maintenance_issue").on(
      t.maintenanceIssueId,
    ),
    maintenanceTicketUnique: uniqueIndex("uq_guest_requests_maintenance_ticket").on(
      t.maintenanceTicketId,
    ),
  }),
);

export type GuestRequest = typeof guestRequests.$inferSelect;
export type NewGuestRequest = typeof guestRequests.$inferInsert;

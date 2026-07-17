import { sql } from "drizzle-orm";
import {
  check,
  date,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { BOOKING_SOURCES, RESERVATION_STATUSES } from "./enums.js";
import { guests } from "./guests.js";
import { profiles } from "./profiles.js";
import { properties } from "./properties.js";
import { rooms } from "./rooms.js";

export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationNumber: text("reservation_number").notNull().unique(),
    // Phase 2: reservations live under a property. Back-filled to
    // PRIMARY by migration 0013.
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id),
    checkInDate: date("check_in_date").notNull(),
    checkOutDate: date("check_out_date").notNull(),
    // 'overnight' (default) — traditional night-based booking.
    // 'short_stay' — same-calendar-day day-use booking measured in hours;
    // duration_hours is required and check_out_date == check_in_date.
    stayType: text("stay_type", { enum: ["overnight", "short_stay"] as const })
      .notNull()
      .default("overnight"),
    durationHours: numeric("duration_hours", { precision: 5, scale: 2 }),
    numAdults: integer("num_adults").notNull().default(1),
    numChildren: integer("num_children").notNull().default(0),
    ratePerNight: numeric("rate_per_night", { precision: 10, scale: 2 }).notNull(),
    numNights: integer("num_nights")
      .notNull()
      .generatedAlwaysAs(sql`(check_out_date - check_in_date)`),
    subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
    gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull(),
    gstAmount: numeric("gst_amount", { precision: 10, scale: 2 }).notNull(),
    grandTotal: numeric("grand_total", { precision: 10, scale: 2 }).notNull(),
    // GST mode snapshot at create time. 'exclusive' means subtotal is the
    // net (GST added on top), 'inclusive' means grand_total already
    // contained GST (subtotal was extracted backwards). Recalcs and
    // edits on this row honour the same mode it was created with, so the
    // property's current setting can change without rewriting history.
    gstMode: text("gst_mode", { enum: ["exclusive", "inclusive"] as const })
      .notNull()
      .default("exclusive"),
    advancePaid: numeric("advance_paid", { precision: 10, scale: 2 }).notNull().default("0"),
    // Wallet credit applied as a discount on this booking. Deducted from
    // balanceDue (and shown as a separate line on the invoice). The source
    // entries live in guest_ledger with entryType='credit_used'.
    walletCreditApplied: numeric("wallet_credit_applied", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    balanceDue: numeric("balance_due", { precision: 10, scale: 2 }).notNull(),
    // Extra hours granted via POST /:id/late-checkout. Added to the hotel's
    // default checkOutTime to compute the effective per-reservation
    // check-out moment. 0 = no extension (the default).
    lateCheckoutHours: numeric("late_checkout_hours", { precision: 4, scale: 2 })
      .notNull()
      .default("0"),
    status: text("status", { enum: RESERVATION_STATUSES }).notNull().default("confirmed"),
    bookingSource: text("booking_source", { enum: BOOKING_SOURCES }).notNull().default("walkin"),
    creditNotes: text("credit_notes"),
    cancellationReason: text("cancellation_reason"),
    specialRequests: text("special_requests"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    checkedInBy: uuid("checked_in_by").references(() => profiles.id),
    checkedOutBy: uuid("checked_out_by").references(() => profiles.id),
    // Migration 0023 — staff-chosen arrival / departure times. Planned
    // / display-only: the desk still flips checkedInAt at the real
    // arrival. NULL falls back to property policy times.
    plannedCheckInAt: timestamp("planned_check_in_at", { withTimezone: true }),
    plannedCheckOutAt: timestamp("planned_check_out_at", { withTimezone: true }),
    // Migration 0048 — the check-out date the reservation was FIRST booked
    // with. Stamped once, on the first /extend, from the then-current
    // checkOutDate. NULL = never extended. Lets the UI show an "Extended"
    // marker and the original departure date.
    originalCheckOutDate: date("original_check_out_date"),
    // Migration 0021 — set once we fire the pre-arrival WhatsApp/SMS
    // reminder. Used to dedupe so the dashboard tick doesn't resend.
    arrivalReminderSentAt: timestamp("arrival_reminder_sent_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => profiles.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    checkOutAfterIn: check(
      "res_checkout_after_checkin",
      sql`(${t.stayType} = 'short_stay' AND ${t.checkOutDate} >= ${t.checkInDate})
        OR (${t.stayType} = 'overnight' AND ${t.checkOutDate} > ${t.checkInDate})`,
    ),
  }),
);

// Per-room state lives here. Each row carries its own occupant guest,
// status, and check-in/check-out timestamps so a multi-room reservation
// can have rooms in different states (e.g. 202 checked-out, 203 still
// checked-in). The PARENT reservation's status is a roll-up: it
// becomes 'checked_out' only when every non-cancelled room has
// checked out.
//
// Per-room status enum is a subset of the reservation enum (no
// inquiry/hold/pending_payment); inherits from parent at create time.
export const RESERVATION_ROOM_STATUSES = [
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
] as const;
export type ReservationRoomStatus = (typeof RESERVATION_ROOM_STATUSES)[number];

export const reservationRooms = pgTable("reservation_rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  reservationId: uuid("reservation_id")
    .notNull()
    .references(() => reservations.id, { onDelete: "cascade" }),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id),
  ratePerNight: numeric("rate_per_night", { precision: 10, scale: 2 }).notNull(),
  soldAsType: text("sold_as_type"),
  // Migration 0043 — extra beds (additional persons) on this room.
  // extraBeds is the count over the room's base max_occupancy; extraBedRate
  // is the per-night, per-person fee snapshot at booking. Both default 0.
  extraBeds: integer("extra_beds").notNull().default(0),
  extraBedRate: numeric("extra_bed_rate", { precision: 10, scale: 2 })
    .notNull()
    .default("0"),
  // Migration 0017 — per-room state.
  guestId: uuid("guest_id")
    .notNull()
    .references(() => guests.id),
  status: text("status", { enum: RESERVATION_ROOM_STATUSES })
    .notNull()
    .default("confirmed"),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  checkedInBy: uuid("checked_in_by").references(() => profiles.id),
  checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
  checkedOutBy: uuid("checked_out_by").references(() => profiles.id),
  // The per-room invoice, once issued. NULL while still chargeable to
  // the combined / pending invoice.
  invoiceId: uuid("invoice_id"),
  // Migration 0019 — segment columns for mid-stay room swap.
  // NULL on either bound means "for the whole stay" (legacy / unsegmented row).
  // When a swap happens, the original row's effective_to is set to the swap
  // date, and a new row is inserted with effective_from = swap date and the
  // new room_id. Both rows share a swap_id so reports can reconstruct the
  // swap event as a single thing.
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  swapId: uuid("swap_id"),
  swapReason: text("swap_reason"),
  // Migration 0036 — in-place swaps (1-night stays, day-use) re-point
  // this row to the new room without creating a sibling segment, so
  // the original room number is otherwise lost. Captured here so the
  // detail page can render "Swapped from Room 203 (Maintenance)" on
  // the active row.
  swappedFromRoomId: uuid("swapped_from_room_id").references(() => rooms.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Migration 0037 — chain of in-place swap hops on a single row. 0036
// stored only the immediately-prior room on reservationRooms; a chain
// of swaps (202 -> 201 -> 301) collapsed to one entry. This table
// preserves every hop so the UI can render a full closed-leg ladder.
export const reservationRoomSwapHistory = pgTable(
  "reservation_room_swap_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationRoomId: uuid("reservation_room_id")
      .notNull()
      .references(() => reservationRooms.id, { onDelete: "cascade" }),
    fromRoomId: uuid("from_room_id")
      .notNull()
      .references(() => rooms.id),
    toRoomId: uuid("to_room_id")
      .notNull()
      .references(() => rooms.id),
    reason: text("reason").notNull(),
    ratePerNight: numeric("rate_per_night", { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
);

// Migration 0020 — co-guest link table. Each row pairs a reservation
// with a real Guest row that occupies the booking alongside the
// booker. Used to enforce "if numAdults >= 2 then at least 1 co-guest
// with KYC".  Position is 1-based and unique per reservation so the
// UI can render slots stably.
export const reservationCoGuests = pgTable("reservation_co_guests", {
  id: uuid("id").primaryKey().defaultRandom(),
  reservationId: uuid("reservation_id")
    .notNull()
    .references(() => reservations.id, { onDelete: "cascade" }),
  guestId: uuid("guest_id")
    .notNull()
    .references(() => guests.id),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Reservation = typeof reservations.$inferSelect;
export type NewReservation = typeof reservations.$inferInsert;
export type ReservationRoom = typeof reservationRooms.$inferSelect;
export type NewReservationRoom = typeof reservationRooms.$inferInsert;
export type ReservationCoGuest = typeof reservationCoGuests.$inferSelect;
export type NewReservationCoGuest = typeof reservationCoGuests.$inferInsert;

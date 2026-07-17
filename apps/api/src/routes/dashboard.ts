import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import { activityLog } from "../db/schema/activity.js";
import { guests } from "../db/schema/guests.js";
import { payments } from "../db/schema/invoices.js";
import { profiles } from "../db/schema/profiles.js";
import { reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { logger } from "../lib/logger.js";
import { messaging } from "../lib/messaging.js";
import { propertyDateString } from "../lib/propertyTime.js";
import { dashboardKey, redis } from "../lib/redis.js";
import { ok } from "../lib/response.js";
import { getSettings } from "../lib/settings.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { hasPermission } from "../lib/permission-resolver.js";

const router = Router();
const TTL_SECONDS = 30;

// Single-property hotel in Sabbavaram (IST). The "today" used for
// check-in/check-out matching MUST be the property's local date, otherwise
// when the API runs in UTC (Render/Vercel/Docker) the panels will be wrong
// for ~5.5 hours each morning.
function propertyToday(): string {
  // ICU-independent yyyy-MM-dd in the property timezone. (Do NOT use
  // toLocaleDateString("en-CA", …) — under the packaged sidecar's small-icu
  // Node it falls back to en-US "M/D/YYYY", producing an unparseable date
  // string that crashed every date-scoped query. See propertyDateString.)
  return propertyDateString(new Date());
}

function propertyStartOfDay(): Date {
  // Start-of-day in IST, expressed as an absolute Date. We do this by
  // taking the IST date string, treating it as midnight in IST, then
  // converting to the equivalent UTC instant.
  const istDate = propertyToday(); // yyyy-MM-dd in IST
  // IST is UTC+05:30, so IST midnight === previous-day 18:30 UTC.
  return new Date(`${istDate}T00:00:00+05:30`);
}

// First IST instant of the current calendar month — used to scope the
// MTD revenue + ADR/RevPAR window. We rely on the IST date string so
// the calculation stays correct regardless of the server timezone.
function propertyStartOfMonth(): Date {
  const istToday = propertyToday();
  const firstOfMonth = `${istToday.slice(0, 7)}-01`;
  return new Date(`${firstOfMonth}T00:00:00+05:30`);
}

// IST yyyy-MM-dd N days from the property's "today" — positive N for
// future dates (forecast), negative for the past. Useful as inclusive
// upper bounds in date comparisons (which are pure strings).
function propertyDateOffset(days: number): string {
  const todayIst = propertyToday();
  const base = new Date(`${todayIst}T00:00:00+05:30`);
  base.setUTCDate(base.getUTCDate() + days);
  return propertyDateString(base);
}

async function buildDashboard(propertyId: string) {
  const today = propertyToday();
  const startOfDay = propertyStartOfDay();
  const startOfMonth = propertyStartOfMonth();
  // 7-day forecast window. Inclusive on both ends. The "next 7 days"
  // means today + 6 in standard calendar talk.
  const forecastEnd = propertyDateOffset(6);
  const settings = await getSettings(propertyId);

  // Pre-arrival reminder window. Confirmed bookings with a check-in
  // date today + (arrivalReminderHoursBefore / 24) round-up days that
  // haven't been reminded yet. We send WhatsApp + surface them as
  // staff alerts.
  const reminderHours = settings.arrivalReminderHoursBefore ?? 24;
  const noShowCutoffHours = settings.noShowCutoffHours ?? 6;
  const reminderWindowEnd = propertyDateOffset(Math.ceil(reminderHours / 24));

  const [
    roomRows,
    occupiedRows,
    todaysCheckins,
    todaysCheckouts,
    overdue,
    revenueRow,
    activity,
    upcomingCheckoutRows,
    mtdRevenueRow,
    outstandingBalanceRow,
    pendingCheckoutsTodayRow,
    roomsOutOfServiceRow,
    forecastRows,
    upcomingArrivalsRow,
    likelyNoShowsRow,
    revenueByMethodTodayRows,
  ] = await Promise.all([
      db
        .select()
        .from(rooms)
        .where(eq(rooms.propertyId, propertyId))
        .orderBy(rooms.floor, rooms.roomNumber),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(rooms)
        .where(and(eq(rooms.propertyId, propertyId), eq(rooms.status, "occupied"))),
      // "Arriving today" — every reservation whose check-in date is today
      // and isn't cancelled/no-show. Includes already-checked-in so staff
      // can see "they did arrive" rather than the row vanishing the moment
      // someone hits the check-in button. room_numbers is a comma-joined
      // list because a single reservation can span multiple rooms.
      db
        .select({
          id: reservations.id,
          reservationNumber: reservations.reservationNumber,
          guestName: guests.fullName,
          status: reservations.status,
          // Each "slot" on a reservation is either:
          //   - one unsegmented reservation_rooms row → emit roomNumber
          //   - one or more rows sharing a swap_id (mid-stay swap) →
          //     collapse to "OLD→NEW" ordered by effective_from
          // Slots are then comma-joined for display.
          // Each "slot" on a reservation is either:
          //   - one unsegmented reservation_rooms row → emit roomNumber
          //   - one or more rows sharing a swap_id (mid-stay swap) →
          //     collapse to "OLD→NEW" ordered by effective_from
          // For swap groups we pick the earliest-created row as the
          // canonical representative to avoid duplicating the slot.
          // Slots are then comma-joined for display.
          roomNumbers: sql<string>`COALESCE((
            SELECT string_agg(slot_label, ',' ORDER BY slot_label)
            FROM (
              SELECT
                CASE
                  WHEN rr.swap_id IS NULL THEN r.room_number
                  ELSE (
                    SELECT string_agg(r2.room_number, '→' ORDER BY rr2.effective_from NULLS FIRST)
                    FROM reservation_rooms rr2
                    JOIN rooms r2 ON r2.id = rr2.room_id
                    WHERE rr2.swap_id = rr.swap_id
                  )
                END AS slot_label
              FROM reservation_rooms rr
              JOIN rooms r ON r.id = rr.room_id
              WHERE rr.reservation_id = ${reservations.id}
                AND (
                  rr.swap_id IS NULL
                  OR rr.created_at = (
                    SELECT MIN(rr3.created_at)
                    FROM reservation_rooms rr3
                    WHERE rr3.swap_id = rr.swap_id
                  )
                )
            ) slots
          ), '')`,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            eq(reservations.checkInDate, today),
            inArray(reservations.status, ["confirmed", "checked_in"]),
          ),
        ),
      // "Leaving today" — every reservation whose check-out date is today
      // and isn't cancelled/no-show. Includes already-checked-out for the
      // same reason as above.
      db
        .select({
          id: reservations.id,
          reservationNumber: reservations.reservationNumber,
          guestName: guests.fullName,
          status: reservations.status,
          // Each "slot" on a reservation is either:
          //   - one unsegmented reservation_rooms row → emit roomNumber
          //   - one or more rows sharing a swap_id (mid-stay swap) →
          //     collapse to "OLD→NEW" ordered by effective_from
          // Slots are then comma-joined for display.
          // Each "slot" on a reservation is either:
          //   - one unsegmented reservation_rooms row → emit roomNumber
          //   - one or more rows sharing a swap_id (mid-stay swap) →
          //     collapse to "OLD→NEW" ordered by effective_from
          // For swap groups we pick the earliest-created row as the
          // canonical representative to avoid duplicating the slot.
          // Slots are then comma-joined for display.
          roomNumbers: sql<string>`COALESCE((
            SELECT string_agg(slot_label, ',' ORDER BY slot_label)
            FROM (
              SELECT
                CASE
                  WHEN rr.swap_id IS NULL THEN r.room_number
                  ELSE (
                    SELECT string_agg(r2.room_number, '→' ORDER BY rr2.effective_from NULLS FIRST)
                    FROM reservation_rooms rr2
                    JOIN rooms r2 ON r2.id = rr2.room_id
                    WHERE rr2.swap_id = rr.swap_id
                  )
                END AS slot_label
              FROM reservation_rooms rr
              JOIN rooms r ON r.id = rr.room_id
              WHERE rr.reservation_id = ${reservations.id}
                AND (
                  rr.swap_id IS NULL
                  OR rr.created_at = (
                    SELECT MIN(rr3.created_at)
                    FROM reservation_rooms rr3
                    WHERE rr3.swap_id = rr.swap_id
                  )
                )
            ) slots
          ), '')`,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            eq(reservations.checkOutDate, today),
            inArray(reservations.status, ["checked_in", "checked_out"]),
          ),
        ),
      db
        .select({
          id: reservations.id,
          reservationNumber: reservations.reservationNumber,
          guestName: guests.fullName,
          status: reservations.status,
          checkOutDate: reservations.checkOutDate,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            lt(reservations.checkOutDate, today),
            eq(reservations.status, "checked_in"),
          ),
        ),
      // Revenue today — payments received today on non-complimentary
      // reservations only. Comp bookings live in Reports → Complimentary;
      // their cash flow is intentionally excluded from "real revenue".
      db
        .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text` })
        .from(payments)
        .innerJoin(reservations, eq(reservations.id, payments.reservationId))
        .where(
          and(
            eq(payments.propertyId, propertyId),
            eq(reservations.propertyId, propertyId),
            gte(payments.paymentDate, startOfDay),
            eq(payments.voided, false),
            eq(payments.status, "received"),
            sql`${reservations.bookingSource} <> 'complimentary'`,
          ),
        ),
      db
        .select({
          action: activityLog.action,
          description: activityLog.description,
          performedBy: profiles.fullName,
          createdAt: activityLog.createdAt,
          entityType: activityLog.entityType,
          entityId: activityLog.entityId,
          // For reservation activities, join the room numbers so the UI can
          // show "RES-0031 (Room 302) checked in" instead of just the
          // reservation number. NULL for non-reservation activities.
          roomNumbers: sql<string | null>`(
            SELECT string_agg(${rooms.roomNumber}, ', ' ORDER BY ${rooms.roomNumber})
            FROM ${reservationRooms}
            INNER JOIN ${rooms} ON ${rooms.id} = ${reservationRooms.roomId}
            WHERE ${activityLog.entityType} = 'reservation'
              AND ${reservationRooms.reservationId} = ${activityLog.entityId}::uuid
          )`,
        })
        .from(activityLog)
        .innerJoin(profiles, eq(profiles.id, activityLog.performedBy))
        // Hide activity tied to complimentary reservations — they're
        // silent everywhere outside the Complimentary report. (entity_id
        // is a uuid column, so the join is always type-safe.)
        .where(
          and(
            eq(activityLog.propertyId, propertyId),
            sql`NOT (${activityLog.entityType} = 'reservation' AND EXISTS (
              SELECT 1 FROM ${reservations} r
              WHERE r.id = ${activityLog.entityId}
                AND r.booking_source = 'complimentary'))`,
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(10),
      // Upcoming check-outs — every reservation that is checked_in and is
      // supposed to leave today. We pull the per-reservation late-checkout
      // grant so the client can compute an accurate effective check-out
      // datetime (hotel default + extension). Rooms are joined as a
      // comma-list for display.
      db
        .select({
          id: reservations.id,
          reservationNumber: reservations.reservationNumber,
          guestName: guests.fullName,
          checkInDate: reservations.checkInDate,
          checkOutDate: reservations.checkOutDate,
          stayType: reservations.stayType,
          durationHours: reservations.durationHours,
          checkedInAt: reservations.checkedInAt,
          lateCheckoutHours: reservations.lateCheckoutHours,
          // Staff-chosen planned exit time. When set it is the source of
          // truth for the effective check-out moment (the reservation
          // detail page already honours it); the hotel default + late
          // grant is only the fallback when this is null.
          plannedCheckOutAt: reservations.plannedCheckOutAt,
          // Each "slot" on a reservation is either:
          //   - one unsegmented reservation_rooms row → emit roomNumber
          //   - one or more rows sharing a swap_id (mid-stay swap) →
          //     collapse to "OLD→NEW" ordered by effective_from
          // Slots are then comma-joined for display.
          // Each "slot" on a reservation is either:
          //   - one unsegmented reservation_rooms row → emit roomNumber
          //   - one or more rows sharing a swap_id (mid-stay swap) →
          //     collapse to "OLD→NEW" ordered by effective_from
          // For swap groups we pick the earliest-created row as the
          // canonical representative to avoid duplicating the slot.
          // Slots are then comma-joined for display.
          roomNumbers: sql<string>`COALESCE((
            SELECT string_agg(slot_label, ',' ORDER BY slot_label)
            FROM (
              SELECT
                CASE
                  WHEN rr.swap_id IS NULL THEN r.room_number
                  ELSE (
                    SELECT string_agg(r2.room_number, '→' ORDER BY rr2.effective_from NULLS FIRST)
                    FROM reservation_rooms rr2
                    JOIN rooms r2 ON r2.id = rr2.room_id
                    WHERE rr2.swap_id = rr.swap_id
                  )
                END AS slot_label
              FROM reservation_rooms rr
              JOIN rooms r ON r.id = rr.room_id
              WHERE rr.reservation_id = ${reservations.id}
                AND (
                  rr.swap_id IS NULL
                  OR rr.created_at = (
                    SELECT MIN(rr3.created_at)
                    FROM reservation_rooms rr3
                    WHERE rr3.swap_id = rr.swap_id
                  )
                )
            ) slots
          ), '')`,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            eq(reservations.checkOutDate, today),
            eq(reservations.status, "checked_in"),
          ),
        ),
      // Month-to-date collected revenue. Same exclusions as revenue
      // today (received, non-voided, non-complimentary). Drives the
      // MTD KPI card; rolling forward into "this calendar month" so
      // it resets cleanly on the 1st.
      db
        .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text` })
        .from(payments)
        .innerJoin(reservations, eq(reservations.id, payments.reservationId))
        .where(
          and(
            eq(payments.propertyId, propertyId),
            eq(reservations.propertyId, propertyId),
            gte(payments.paymentDate, startOfMonth),
            eq(payments.voided, false),
            eq(payments.status, "received"),
            sql`${reservations.bookingSource} <> 'complimentary'`,
          ),
        ),
      // Outstanding balance — money the property is still owed. Sum
      // over every non-cancelled reservation's authoritative
      // balance_due (recomputed from payments + walletCredit by the
      // single-source-of-truth helper). The old "latest invoice's
      // balance" heuristic was wrong for multi-invoice bookings (e.g.
      // per-room invoices with the same created_at) and could pick a
      // swap-leg micro-invoice that's unpaid in isolation even when
      // the reservation as a whole is fully settled.
      db.execute<{ total: string }>(sql`
        SELECT COALESCE(SUM(r.balance_due::numeric), 0)::text AS total
        FROM ${reservations} r
        WHERE r.property_id = ${propertyId}
          AND r.booking_source <> 'complimentary'
          AND r.status <> 'cancelled'
      `),
      // Pending check-outs today — reservations whose check-out date
      // is today AND status is still 'checked_in' (i.e. the guest is
      // still in-house and needs to be processed). Cancelled bookings
      // and already checked-out rows are excluded.
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(reservations)
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            eq(reservations.checkOutDate, today),
            eq(reservations.status, "checked_in"),
          ),
        ),
      // Rooms out of service — physically unavailable inventory.
      // Counts rooms in maintenance + dirty (housekeeping debt). These
      // can't be sold until the underlying state changes, so the desk
      // should know how much of the inventory is currently dark.
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(rooms)
        .where(and(eq(rooms.propertyId, propertyId), inArray(rooms.status, ["maintenance", "dirty"]))),
      // 7-day forecast: per-day count of reservations occupying a
      // room. We unnest a generate_series over the window and join
      // against reservation_rooms whose parent overlaps the day. The
      // result is one row per day with a `count`.
      db.execute<{ day: string; occupied: number; arrivals: number }>(
        sql`
          WITH days AS (
            SELECT generate_series(
              ${today}::date,
              ${forecastEnd}::date,
              interval '1 day'
            )::date AS d
          )
          SELECT
            to_char(d, 'YYYY-MM-DD') AS day,
            COALESCE((
              SELECT COUNT(DISTINCT rr.room_id)::int
              FROM reservation_rooms rr
              JOIN reservations r ON r.id = rr.reservation_id
              WHERE r.property_id = ${propertyId}
                AND r.status IN ('confirmed','checked_in','hold','pending_payment')
                AND daterange(r.check_in_date, GREATEST(r.check_out_date, r.check_in_date + 1), '[)')
                    @> d
            ), 0) AS occupied,
            COALESCE((
              SELECT COUNT(*)::int
              FROM reservations r
              WHERE r.property_id = ${propertyId}
                AND r.status IN ('confirmed','checked_in','hold','pending_payment')
                AND r.check_in_date = d
            ), 0) AS arrivals
          FROM days
          ORDER BY d
        `,
      ),
      // Upcoming arrivals — confirmed bookings due to check in within
      // the reminder window [today, today + ceil(hoursBefore/24)].
      // Includes whether the WhatsApp reminder has already been sent.
      db
        .select({
          id: reservations.id,
          reservationNumber: reservations.reservationNumber,
          guestName: guests.fullName,
          guestPhone: guests.phone,
          checkInDate: reservations.checkInDate,
          arrivalReminderSentAt: reservations.arrivalReminderSentAt,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            eq(reservations.status, "confirmed"),
            gte(reservations.checkInDate, today),
            lte(reservations.checkInDate, reminderWindowEnd),
            // Complimentary bookings get no arrival reminder (banner or
            // WhatsApp) — they're silent everywhere outside the comp report.
            sql`${reservations.bookingSource} <> 'complimentary'`,
          ),
        )
        .orderBy(reservations.checkInDate),
      // Likely no-shows — confirmed bookings whose check-in date is
      // today AND the cutoff (hotel check-in time + cutoffHours) has
      // already passed. Staff sees a red banner asking to verify and
      // either check-in or mark no-show. No automatic state change.
      db
        .select({
          id: reservations.id,
          reservationNumber: reservations.reservationNumber,
          guestName: guests.fullName,
          guestPhone: guests.phone,
          checkInDate: reservations.checkInDate,
          // The booking's own arrival time when staff set one. The cutoff is
          // measured from THIS, not the hotel's default check-in time — a
          // guest due at 11:50 PM isn't a no-show at 6 PM.
          plannedCheckInAt: reservations.plannedCheckInAt,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            eq(reservations.status, "confirmed"),
            lte(reservations.checkInDate, today),
            // No no-show alert for complimentary bookings.
            sql`${reservations.bookingSource} <> 'complimentary'`,
          ),
        )
        .orderBy(reservations.checkInDate),
      // Revenue today, broken down by payment method (Cash / UPI / Card /
      // Bank transfer / Cheque). Same filter as revenue_today above:
      // received, not voided, non-complimentary, paid today. Drives the
      // dashboard's daily money overview / owner cash-up.
      db
        .select({
          method: payments.paymentMethod,
          total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text`,
          // Refunds are stored as NEGATIVE payments, so a day whose only
          // movement is a refund of an earlier booking nets out below zero.
          // Split the money in/out so the tile can explain itself instead of
          // just showing a mysterious minus number.
          collected: sql<string>`COALESCE(SUM(${payments.amount}) FILTER (WHERE ${payments.amount} > 0), 0)::text`,
          refunded: sql<string>`COALESCE(-SUM(${payments.amount}) FILTER (WHERE ${payments.amount} < 0), 0)::text`,
          count: sql<number>`count(*) FILTER (WHERE ${payments.amount} > 0)::int`,
          refundCount: sql<number>`count(*) FILTER (WHERE ${payments.amount} < 0)::int`,
        })
        .from(payments)
        .innerJoin(reservations, eq(reservations.id, payments.reservationId))
        .where(
          and(
            eq(payments.propertyId, propertyId),
            eq(reservations.propertyId, propertyId),
            gte(payments.paymentDate, startOfDay),
            eq(payments.voided, false),
            eq(payments.status, "received"),
            sql`${reservations.bookingSource} <> 'complimentary'`,
          ),
        )
        .groupBy(payments.paymentMethod),
    ]);

  const occupiedCount = occupiedRows[0]?.count ?? 0;
  const total = roomRows.length;
  const percentage = total ? Math.round((occupiedCount / total) * 100) : 0;

  const roomResMap = new Map<
    string,
    {
      reservationId: string;
      reservationNumber: string;
      guestName: string;
      resStatus: string;
      checkInDate: string;
      checkOutDate: string;
    }
  >();
  // Same-day re-let watch. A room is re-let-pending when:
  //   - A walk-in is currently checked_in AND due to check out today
  //   - The same room also has a confirmed booking arriving by tomorrow
  // The dashboard tile shows a small dot so the desk knows the
  // RESERVED room is actually occupied right now and needs to be
  // turned over before the next guest arrives.
  const reletByRoom = new Map<
    string,
    { nextGuestName: string; nextCheckIn: string }
  >();
  // Segmented mid-stay swaps (0019) produce multiple reservation_rooms
  // rows with different [effective_from, effective_to) windows. For
  // tile-status purposes only the currently-active segment matters —
  // otherwise both the closed-leg room (e.g. 303 yesterday) and the
  // not-yet-started successor (304 tomorrow) would both light up as
  // OCCUPIED. NULL bounds mean the row covers the whole stay.
  const todayDate = propertyDateOffset(0);
  const liveReservations = await db
    .select({
      roomId: reservationRooms.roomId,
      reservationId: reservations.id,
      reservationNumber: reservations.reservationNumber,
      guestName: guests.fullName,
      resStatus: reservations.status,
      checkInDate: reservations.checkInDate,
      checkOutDate: reservations.checkOutDate,
    })
    .from(reservationRooms)
    .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
    .innerJoin(guests, eq(guests.id, reservations.guestId))
    .where(
      and(
        eq(reservations.propertyId, propertyId),
        inArray(reservations.status, ["checked_in", "confirmed"]),
        // Active segment filter — exclude closed-leg rows (effective_to
        // already passed) and future-leg rows (effective_from not yet
        // reached). NULL bounds mean "whole stay" so they pass through.
        sql`(${reservationRooms.effectiveFrom} IS NULL OR ${reservationRooms.effectiveFrom} <= ${todayDate})`,
        sql`(${reservationRooms.effectiveTo} IS NULL OR ${reservationRooms.effectiveTo} > ${todayDate})`,
      ),
    );
  const tomorrow = propertyDateOffset(1);
  for (const r of liveReservations) {
    // Prefer checked_in over confirmed when both exist. Among multiple
    // confirmed bookings on the same room, prefer the soonest one so
    // the tile shows the earliest hold date.
    const existing = roomResMap.get(r.roomId);
    const isUpgrade =
      !existing ||
      (existing.resStatus !== "checked_in" && r.resStatus === "checked_in") ||
      (existing.resStatus === r.resStatus &&
        r.checkInDate < existing.checkInDate);
    if (isUpgrade) {
      roomResMap.set(r.roomId, {
        reservationId: r.reservationId,
        reservationNumber: r.reservationNumber,
        guestName: r.guestName,
        resStatus: r.resStatus,
        checkInDate: r.checkInDate,
        checkOutDate: r.checkOutDate,
      });
    }
  }
  // Second pass for re-let. A room qualifies when it has BOTH a
  // checked_in row whose check_out_date is today or earlier AND a
  // confirmed row whose check_in_date is today/tomorrow.
  const checkedInToday = new Set<string>();
  const futureConfirmed = new Map<
    string,
    { guestName: string; checkInDate: string }
  >();
  for (const r of liveReservations) {
    if (r.resStatus === "checked_in" && r.checkOutDate <= tomorrow) {
      checkedInToday.add(r.roomId);
    } else if (
      r.resStatus === "confirmed" &&
      r.checkInDate >= today &&
      r.checkInDate <= tomorrow
    ) {
      const existing = futureConfirmed.get(r.roomId);
      if (!existing || r.checkInDate < existing.checkInDate) {
        futureConfirmed.set(r.roomId, {
          guestName: r.guestName,
          checkInDate: r.checkInDate,
        });
      }
    }
  }
  for (const roomId of checkedInToday) {
    const next = futureConfirmed.get(roomId);
    if (next) {
      reletByRoom.set(roomId, {
        nextGuestName: next.guestName,
        nextCheckIn: next.checkInDate,
      });
    }
  }

  return {
    occupancy: { occupied: occupiedCount, total, percentage },
    today_checkins: { count: todaysCheckins.length, reservations: todaysCheckins },
    today_checkouts: { count: todaysCheckouts.length, reservations: todaysCheckouts },
    overdue: {
      count: overdue.length,
      reservations: overdue.map((o) => ({
        id: o.id,
        reservationNumber: o.reservationNumber,
        guestName: o.guestName,
        status: o.status,
        checkOutDate: o.checkOutDate,
        daysOverdue: Math.max(
          0,
          Math.floor(
            (new Date(today + "T00:00:00").getTime() - new Date(o.checkOutDate + "T00:00:00").getTime()) /
              86400000,
          ),
        ),
      })),
    },
    // Upcoming check-outs for today — used by the front-desk's checkout
    // alert bar. For overnight stays the effective time is the hotel's
    // default checkOutTime + any lateCheckoutHours grant. For short_stay
    // (day-use) the effective time is checkedInAt + durationHours, or, if
    // not yet checked in, checkInDate + checkInTime + durationHours. All
    // computed in IST so the client just renders the ISO string.
    upcoming_checkouts: upcomingCheckoutRows.map((u) => {
      const isShortStay = u.stayType === "short_stay";
      let effectiveMs: number;
      if (isShortStay) {
        const durMs = Math.round(Number(u.durationHours ?? 0) * 3600 * 1000);
        const startMs = u.checkedInAt
          ? new Date(u.checkedInAt).getTime()
          : (() => {
              const [ch, cm] = (settings.checkInTime ?? "12:00").split(":");
              return new Date(
                `${u.checkInDate}T${(ch ?? "12").padStart(2, "0")}:${(cm ?? "00").padStart(2, "0")}:00+05:30`,
              ).getTime();
            })();
        effectiveMs = startMs + durMs;
      } else if (u.plannedCheckOutAt) {
        // Staff set an explicit planned exit time — honour it exactly, the
        // same as the reservation detail page. The late-checkout grant is
        // already folded into a planned time when one is chosen, so we do
        // not add lateCheckoutHours on top here.
        effectiveMs = new Date(u.plannedCheckOutAt).getTime();
      } else {
        const [hh, mm] = (settings.checkOutTime ?? "11:00").split(":");
        const baseMs = new Date(
          `${u.checkOutDate}T${(hh ?? "11").padStart(2, "0")}:${(mm ?? "00").padStart(2, "0")}:00+05:30`,
        ).getTime();
        const extraMs = Math.round(Number(u.lateCheckoutHours ?? 0) * 3600 * 1000);
        effectiveMs = baseMs + extraMs;
      }
      return {
        id: u.id,
        reservationNumber: u.reservationNumber,
        guestName: u.guestName,
        roomNumbers: u.roomNumbers,
        stayType: u.stayType,
        durationHours: u.durationHours ? Number(u.durationHours) : null,
        lateCheckoutHours: Number(u.lateCheckoutHours ?? 0),
        effectiveCheckoutAt: new Date(effectiveMs).toISOString(),
      };
    }),
    revenue_today: {
      // Net cash movement (collections minus refunds) — what actually went
      // through the drawer today. Can be negative on a refund-only day.
      total_collected: Number(revenueRow[0]?.total ?? 0),
      // Gross split so a negative net is self-explanatory on the tile.
      gross_collected: +revenueByMethodTodayRows
        .reduce((s, m) => s + Number(m.collected), 0)
        .toFixed(2),
      total_refunded: +revenueByMethodTodayRows
        .reduce((s, m) => s + Number(m.refunded), 0)
        .toFixed(2),
      // Per-method split for the daily money overview / owner cash-up.
      by_method: revenueByMethodTodayRows.map((m) => ({
        method: m.method,
        total: +Number(m.total).toFixed(2),
        collected: +Number(m.collected).toFixed(2),
        refunded: +Number(m.refunded).toFixed(2),
        count: m.count,
        refund_count: m.refundCount,
      })),
    },
    // Industry-standard hospitality KPIs.
    //   MTD revenue          = total collected since the 1st of this month.
    //   Outstanding balance  = total unpaid across every non-cancelled
    //                          reservation. Receivables snapshot — the
    //                          desk knows how much is sitting in
    //                          uncollected bills right now.
    revenue_kpis: {
      mtd_collected: +Number(mtdRevenueRow[0]?.total ?? 0).toFixed(2),
      outstanding_balance: +Number(
        (outstandingBalanceRow as unknown as { total: string }[])[0]?.total ?? 0,
      ).toFixed(2),
    },
    // Operational counters shown alongside Revenue MTD on the dashboard.
    // Visible to everyone (no money). pending_checkouts_today drives the
    // morning work queue; rooms_out_of_service surfaces housekeeping /
    // maintenance debt.
    operations_kpis: {
      pending_checkouts_today: Number(pendingCheckoutsTodayRow[0]?.count ?? 0),
      rooms_out_of_service: Number(roomsOutOfServiceRow[0]?.count ?? 0),
    },
    // Pre-arrival reminders + no-show watch (migration 0021).
    //   upcoming_arrivals — confirmed bookings checking in within the
    //     reminder window. The UI shows them as a sticky banner so the
    //     desk knows who's expected.
    //   likely_no_shows — confirmed bookings whose check-in date is
    //     today and the cutoff time has passed. Staff sees a red row
    //     and either checks them in (if they walked in late) or hits
    //     Mark No-show.
    ...(() => {
      // A booking is EITHER expected (arrivals banner) or overdue (no-show
      // banner) — never both. Compute the no-show set first, then subtract it
      // from the arrivals list: once the cutoff passes, the "arriving today"
      // reminder is stale and only the red "verify or mark" row should stand.
      //
      // Cutoff: a confirmed booking is flagged when
      //   check_in_date < today (yesterday or earlier, never arrived)
      //   OR the guest's expected arrival + cutoffHours has passed today.
      // "Expected arrival" is the booking's own plannedCheckInAt when staff
      // set one, else the hotel's default check-in time.
      const [hStr, mStr] = (settings.checkInTime ?? "12:00").split(":");
      const defaultArrivalMs = (Number(hStr) * 60 + Number(mStr)) * 60 * 1000;
      const cutoffWindowMs = noShowCutoffHours * 60 * 60 * 1000;
      const todayMidnight = new Date(`${today}T00:00:00+05:30`).getTime();
      const nowEpoch = Date.now();

      const noShows = likelyNoShowsRow.filter((r) => {
        if (r.checkInDate < today) return true;
        const plannedMs = r.plannedCheckInAt
          ? new Date(r.plannedCheckInAt).getTime()
          : todayMidnight + defaultArrivalMs;
        return nowEpoch >= plannedMs + cutoffWindowMs;
      });
      const noShowIds = new Set(noShows.map((r) => r.id));

      return {
        upcoming_arrivals: upcomingArrivalsRow
          .filter((r) => !noShowIds.has(r.id))
          .map((r) => ({
            id: r.id,
            reservationNumber: r.reservationNumber,
            guestName: r.guestName,
            guestPhone: r.guestPhone,
            checkInDate: r.checkInDate,
            reminderSent: r.arrivalReminderSentAt !== null,
          })),
        likely_no_shows: noShows.map((r) => ({
          id: r.id,
          reservationNumber: r.reservationNumber,
          guestName: r.guestName,
          guestPhone: r.guestPhone,
          checkInDate: r.checkInDate,
          daysLate: Math.max(
            0,
            Math.floor(
              (new Date(`${today}T00:00:00`).getTime() -
                new Date(`${r.checkInDate}T00:00:00`).getTime()) /
                86400000,
            ),
          ),
        })),
      };
    })(),
    // 7-day occupancy + arrivals forecast. Drives the "next week"
    // strip on the dashboard. % is computed client-side so we don't
    // also have to plumb totalRooms into every row.
    forecast: {
      total_rooms: roomRows.length,
      days: (forecastRows as unknown as { day: string; occupied: number; arrivals: number }[]).map(
        (r) => ({
          day: r.day,
          occupied: Number(r.occupied),
          arrivals: Number(r.arrivals),
        }),
      ),
    },
    room_grid: roomRows.map((r) => {
      const live = roomResMap.get(r.id);
      // Effective tile status:
      //   - checked_in            → occupied (someone is in it now)
      //   - confirmed, today      → reserved (arriving later today, blocked)
      //   - confirmed, future     → available (bookable tonight, will be
      //                             held later) — UI shows a "till [date]"
      //                             hint so staff sees the upcoming hold
      //   - no live booking       → fall through to physical room status
      let effectiveStatus = r.status;
      if (live) {
        if (live.resStatus === "checked_in") {
          effectiveStatus = "occupied";
        } else if (live.checkInDate <= today) {
          effectiveStatus = "reserved";
        } else {
          // Future-only hold — keep the room visually available so the
          // front desk doesn't read "RESERVED" as "untouchable today".
          effectiveStatus = r.status === "reserved" ? "available" : r.status;
        }
      }
      return {
        id: r.id,
        room_number: r.roomNumber,
        room_type: r.roomType,
        floor: r.floor,
        status: effectiveStatus,
        guest_name: live?.guestName ?? null,
        reservation_id: live?.reservationId ?? null,
        // Human-readable SLDT-RES-NNNN — preferred for URL building so
        // navigating to a tile produces a shareable URL.
        reservation_number: live?.reservationNumber ?? null,
        // Earliest upcoming hold window for this room (yyyy-MM-dd)
        // when the next reservation hasn't started yet. The tile uses
        // both ends to render "HELD 02 → 03 JUN" so the desk sees
        // exactly when the room is locked.
        held_from:
          live && live.resStatus === "confirmed" && live.checkInDate > today
            ? live.checkInDate
            : null,
        held_to:
          live && live.resStatus === "confirmed" && live.checkInDate > today
            ? live.checkOutDate
            : null,
        // Set when the room has both a same-day walk-in and a
        // confirmed booking arriving within 24h. The dashboard tile
        // shows a small blue dot so the desk can spot the conflict.
        relet_pending: reletByRoom.get(r.id) ?? null,
      };
    }),
    recent_activity: activity.map((a) => ({
      action: a.action,
      performedBy: a.performedBy,
      createdAt: a.createdAt,
      description: a.roomNumbers
        ? `${a.description} (Room ${a.roomNumbers})`
        : a.description,
    })),
  };
}

router.get("/", requireAuth, requirePermission("view_dashboard"), async (req, res) => {
  // Cache key is always the full payload (with revenue). Per-request we
  // strip revenue fields by permission, so staff with different perms
  // hit the same cache entry. Stripping is cheap; keeping perm-specific
  // cache variants would multiply invalidations.
  //
  // Three tiers:
  //   • view_revenue            → everything (today + MTD + outstanding).
  //   • view_daily_collections  → today's cash-up + outstanding balance;
  //                               MTD revenue (mtd_collected) stripped.
  //   • neither                 → all revenue stripped.
  const canSeeRevenue = hasPermission(req.user!, "view_revenue");
  const canSeeDaily = canSeeRevenue || hasPermission(req.user!, "view_daily_collections");
  const project = <
    T extends {
      revenue_today?: unknown;
      revenue_kpis?: { mtd_collected?: number; outstanding_balance?: number };
    },
  >(d: T) => (canSeeRevenue ? d : canSeeDaily ? keepDailyOnly(d) : stripRevenue(d));

  const cacheKey = dashboardKey(req.propertyId);
  try {
    const cached = await redis.get<string>(cacheKey);
    if (cached) {
      const data = typeof cached === "string" ? JSON.parse(cached) : cached;
      return ok(res, project(data));
    }
  } catch (err) {
    logger.warn({ err }, "dashboard cache read failed");
  }

  const data = await buildDashboard(req.propertyId);
  try {
    await redis.setex(cacheKey, TTL_SECONDS, JSON.stringify(data));
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err }, "dashboard cache write skipped");
  }
  // Fire-and-forget: send any due arrival reminders. The race lock is
  // the DB UPDATE — only the row that flips from NULL to now() actually
  // sends. Concurrent dashboard ticks see "already sent" and skip.
  void dispatchDueArrivalReminders(req.propertyId, data.upcoming_arrivals).catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : err }, "arrival reminders dispatch failed");
  });
  return ok(res, project(data));
});

// Remove revenue-bearing fields so they never leave the server for users
// without `view_revenue`. Phase 1 added revenue_kpis (MTD/ADR/RevPAR);
// strip those alongside revenue_today. Forecast is occupancy-only with
// no money, so it stays visible to everyone (housekeeping needs it too).
function stripRevenue<T extends { revenue_today?: unknown; revenue_kpis?: unknown }>(
  data: T,
): Omit<T, "revenue_today" | "revenue_kpis"> {
  const { revenue_today: _r1, revenue_kpis: _r2, ...rest } = data;
  void _r1;
  void _r2;
  return rest;
}

// For `view_daily_collections` staff: keep revenue_today (the cash-up)
// and the outstanding_balance KPI (front desk chases unpaid balances at
// checkout), but DROP mtd_collected — month-to-date revenue stays
// management-only (view_revenue). We rebuild revenue_kpis with just the
// outstanding figure so MTD never leaves the server.
function keepDailyOnly<
  T extends { revenue_kpis?: { mtd_collected?: number; outstanding_balance?: number } },
>(data: T): T {
  if (!data.revenue_kpis) return data;
  const { mtd_collected: _mtd, ...keep } = data.revenue_kpis;
  void _mtd;
  return { ...data, revenue_kpis: keep };
}

// Pre-arrival reminder dispatcher (migration 0021). Iterates the
// upcoming-arrivals list from the dashboard build. For each booking
// without a sent-marker, claim the row via UPDATE…RETURNING (the
// claim is atomic), then send WhatsApp. If anyone else already
// claimed the row, the UPDATE returns 0 and we skip — no double-send.
//
// Send body is intentionally minimal: hotel name + booking number +
// check-in date + hotel phone. The exact template is the property's
// choice via Settings later; default is fine here.
async function dispatchDueArrivalReminders(
  propertyId: string,
  arrivals: {
    id: string;
    reservationNumber: string;
    guestName: string;
    guestPhone: string;
    checkInDate: string;
    reminderSent: boolean;
  }[],
): Promise<void> {
  const candidates = arrivals.filter((a) => !a.reminderSent);
  if (candidates.length === 0) return;
  const s = await getSettings(propertyId);
  for (const a of candidates) {
    const claim = await db
      .update(reservations)
      .set({ arrivalReminderSentAt: new Date() })
      .where(
        and(
          eq(reservations.id, a.id),
          eq(reservations.propertyId, propertyId),
          isNull(reservations.arrivalReminderSentAt),
        ),
      )
      .returning({ id: reservations.id });
    if (claim.length === 0) continue;
    try {
      const text =
        `Hi ${a.guestName.split(" ")[0]}, your booking at ${s.hotelName} ` +
        `(${a.reservationNumber}) is for ${a.checkInDate}. ` +
        `Check-in from ${s.checkInTime ?? "12:00"}. ` +
        `Questions? ${s.hotelPhone}`;
      // messaging.sendSms is the WhatsApp-or-SMS channel (see messaging.ts).
      await messaging.sendSms({ to: a.guestPhone, text });
    } catch (err) {
      // Roll back the sent-marker so a future tick can retry. Best-
      // effort: if THIS update also fails, the marker stays and the
      // guest gets one fewer reminder than ideal — preferable to a
      // possible double-send loop.
      try {
        await db
          .update(reservations)
          .set({ arrivalReminderSentAt: null })
          .where(and(eq(reservations.id, a.id), eq(reservations.propertyId, propertyId)));
      } catch {
        /* ignore — best-effort */
      }
      logger.warn(
        { err: err instanceof Error ? err.message : err, reservationId: a.id },
        "arrival reminder WhatsApp failed",
      );
    }
  }
}

export default router;

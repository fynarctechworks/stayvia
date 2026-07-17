import { and, eq, gte, lte, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { guests } from "../db/schema/guests.js";
import { reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// month: "YYYY-MM". We expand it on the server into the day-range that
// captures every reservation that *touches* that month — i.e. anything whose
// stay overlaps [first-of-month, last-of-month].
const querySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

router.get(
  "/",
  requireAuth,
  requirePermission("view_reservations"),
  validate(querySchema, "query"),
  async (req, res) => {
    const { month } = req.query as unknown as z.infer<typeof querySchema>;

    // First & last calendar day of the requested month (no timezone math —
    // the property's local IST calendar is what staff see). yyyy-mm-dd
    // strings are sortable and compare cleanly against the `date` columns.
    const [y, m] = month.split("-").map(Number);
    const firstDay = `${month}-01`;
    // Day 0 of next month = last day of this month.
    const lastDate = new Date(y!, m!, 0).getDate();
    const lastDay = `${month}-${String(lastDate).padStart(2, "0")}`;

    // A reservation overlaps the month when:
    //   checkInDate  <= lastDay  AND  checkOutDate >= firstDay
    // Day-use (short_stay) bookings have checkInDate === checkOutDate, so
    // the same overlap check still works.
    const rows = await db
      .select({
        id: reservations.id,
        reservationNumber: reservations.reservationNumber,
        status: reservations.status,
        bookingSource: reservations.bookingSource,
        stayType: reservations.stayType,
        durationHours: reservations.durationHours,
        checkInDate: reservations.checkInDate,
        checkOutDate: reservations.checkOutDate,
        guestName: guests.fullName,
        roomNumbers: sql<string>`COALESCE((
          SELECT string_agg(${rooms.roomNumber}, ', ' ORDER BY ${rooms.roomNumber})
          FROM ${reservationRooms}
          JOIN ${rooms} ON ${rooms.id} = ${reservationRooms.roomId}
          WHERE ${reservationRooms.reservationId} = ${reservations.id}
        ), '')`,
      })
      .from(reservations)
      .innerJoin(guests, eq(guests.id, reservations.guestId))
      .where(
        and(
          lte(reservations.checkInDate, lastDay),
          gte(reservations.checkOutDate, firstDay),
          // Complimentary bookings stay off the calendar — they're only
          // visible in the Complimentary report.
          sql`${reservations.bookingSource} <> 'complimentary'`,
        ),
      )
      .orderBy(reservations.checkInDate);

    return ok(res, {
      month,
      firstDay,
      lastDay,
      bookings: rows,
    });
  },
);

export default router;

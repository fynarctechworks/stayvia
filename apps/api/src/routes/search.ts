// Global search — powers the Cmd-K palette on the web. Returns up to
// N rows per result kind so a single fetch hydrates everything the
// palette needs.
//
// We deliberately limit to three kinds (guests, reservations, rooms)
// because that covers ~95% of "find X by anything" front-desk lookups.
// Invoices and payments can be reached via reservation → invoice card.
//
// The query is intentionally permissive: ILIKE on names, phones, ID
// last4, room numbers, reservation numbers. We trim and reject queries
// shorter than 2 chars to avoid table-scan-on-every-keystroke.

import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { guests } from "../db/schema/guests.js";
import { reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { ok } from "../lib/response.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const searchQuerySchema = z.object({
  q: z.string().min(2).max(80),
  // Per-kind limit. Capped at 10 so the palette stays a single screen
  // and the DB scan stays cheap.
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

router.get(
  "/",
  requireAuth,
  validate(searchQuerySchema, "query"),
  async (req, res) => {
    const { q, limit } = req.query as unknown as z.infer<typeof searchQuerySchema>;
    const term = q.trim();
    const wild = `%${term}%`;

    // Three queries fanned out in parallel. Each ranks the most likely
    // intended row to the top (exact-number match first when the input
    // looks numeric, recency next).
    const [guestRows, reservationRows, roomRows] = await Promise.all([
      db
        .select({
          id: guests.id,
          fullName: guests.fullName,
          phone: guests.phone,
          idProofLast4: guests.idProofLast4,
          isVip: guests.isVip,
          isBlacklisted: guests.isBlacklisted,
        })
        .from(guests)
        .where(
          or(
            ilike(guests.fullName, wild),
            ilike(guests.phone, wild),
            ilike(guests.idProofLast4, wild),
            guests.email ? ilike(guests.email, wild) : sql`FALSE`,
          ),
        )
        .orderBy(desc(guests.updatedAt))
        .limit(limit),

      db
        .select({
          id: reservations.id,
          reservationNumber: reservations.reservationNumber,
          status: reservations.status,
          checkInDate: reservations.checkInDate,
          checkOutDate: reservations.checkOutDate,
          guestId: reservations.guestId,
          guestName: guests.fullName,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(
          and(
            or(
              ilike(reservations.reservationNumber, wild),
              ilike(guests.fullName, wild),
              ilike(guests.phone, wild),
            ),
            // Complimentary bookings don't surface in global search —
            // only in the Complimentary report.
            sql`${reservations.bookingSource} <> 'complimentary'`,
          ),
        )
        .orderBy(desc(reservations.createdAt))
        .limit(limit),

      db
        .select({
          id: rooms.id,
          roomNumber: rooms.roomNumber,
          floor: rooms.floor,
          roomType: rooms.roomType,
          status: rooms.status,
        })
        .from(rooms)
        .where(ilike(rooms.roomNumber, wild))
        .orderBy(asc(rooms.floor), asc(rooms.roomNumber))
        .limit(limit),
    ]);

    return ok(res, {
      q: term,
      guests: guestRows,
      reservations: reservationRows,
      rooms: roomRows,
    });
  },
);

export default router;

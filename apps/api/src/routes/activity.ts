import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { activityLog } from "../db/schema/activity.js";
import { profiles } from "../db/schema/profiles.js";
import { reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { propertyDayEnd, propertyDayStart } from "../lib/propertyTime.js";
import { ok } from "../lib/response.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// yyyy-mm-dd. Caller is expected to pass a date string in the property's
// local timezone; we treat it as that calendar day, not UTC.
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const listSchema = z.object({
  date_from: dateStr.optional(),
  date_to: dateStr.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

router.get(
  "/",
  requireAuth,
  validate(listSchema, "query"),
  async (req, res) => {
    const { date_from, date_to, limit } = req.query as unknown as z.infer<typeof listSchema>;

    // Inclusive day-range in the property's timezone. The previous
    // ::date casts compared against DB-timezone (UTC) midnights, so
    // entries logged between 00:00 and 05:30 IST landed in the wrong
    // day's bucket.
    const conds = [];
    if (date_from) conds.push(gte(activityLog.createdAt, propertyDayStart(date_from)));
    if (date_to) conds.push(lte(activityLog.createdAt, propertyDayEnd(date_to)));
    // Hide entries tied to complimentary reservations — they're silent
    // everywhere outside the Complimentary report. (entity_id is a uuid
    // column, so the join below is always type-safe.)
    conds.push(
      sql`NOT (${activityLog.entityType} = 'reservation' AND EXISTS (
        SELECT 1 FROM ${reservations} r
        WHERE r.id = ${activityLog.entityId}
          AND r.booking_source = 'complimentary'))`,
    );

    const rows = await db
      .select({
        id: activityLog.id,
        action: activityLog.action,
        description: activityLog.description,
        performedBy: profiles.fullName,
        createdAt: activityLog.createdAt,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        // Same trick as the dashboard recent_activity: append room numbers
        // for reservation-scoped entries so the Activity page reads as
        // "RES-0035 checked in (Room 203, 204, 302)" not just "RES-0035".
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
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);

    return ok(
      res,
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        performedBy: r.performedBy,
        createdAt: r.createdAt,
        description: r.roomNumbers ? `${r.description} (Room ${r.roomNumbers})` : r.description,
      })),
    );
  },
);

export default router;

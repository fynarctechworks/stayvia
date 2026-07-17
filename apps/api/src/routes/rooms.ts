import {
  availabilityQuerySchema,
  roomCreateSchema,
  roomListQuerySchema,
  roomStatusUpdateSchema,
  roomUpdateSchema,
} from "@hoteldesk/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import { reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { logActivity } from "../lib/activity.js";
import { findAvailableRooms } from "../lib/availability.js";
import { resolveCurrentPropertyId } from "../lib/currentProperty.js";
import { invalidateDashboard } from "../lib/redis.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { resolveRoomId } from "../middleware/resolveRoom.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// Resolve :id to a UUID before every handler — accepts either the
// UUID or the room_number (e.g. "201") so navigation can build
// staff-friendly URLs like /rooms/201.
router.param("id", resolveRoomId as never);

router.get(
  "/availability",
  requireAuth,
  validate(availabilityQuerySchema, "query"),
  async (req, res) => {
    const { check_in, check_out, include_conflicts } = req.query as unknown as {
      check_in: string;
      check_out: string;
      include_conflicts?: "1";
    };
    const available = await findAvailableRooms(check_in, check_out, {
      includeConflicts: include_conflicts === "1",
    });
    return ok(res, available);
  },
);

router.get("/", requireAuth, validate(roomListQuerySchema, "query"), async (req, res) => {
  const { floor, status, type } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (floor !== undefined) conditions.push(eq(rooms.floor, Number(floor)));
  if (status) conditions.push(eq(rooms.status, status as never));
  if (type) conditions.push(eq(rooms.roomType, type as never));

  const data = await db
    .select()
    .from(rooms)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(rooms.roomNumber);
  return ok(res, data);
});

router.get("/:id", requireAuth, async (req, res) => {
  const id = req.params.id!;
  const found = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  if (!found.length) return fail(res, 404, "NOT_FOUND", "Room not found");
  return ok(res, found[0]);
});

router.post("/", requireAuth, requirePermission("edit_rooms"), validate(roomCreateSchema), async (req, res) => {
  const input = req.body;
  try {
    const propertyId = await resolveCurrentPropertyId(req);
    const [created] = await db
      .insert(rooms)
      .values({
        ...input,
        propertyId,
        baseRate: String(input.baseRate),
      })
      .returning();
    await logActivity({
      action: "room_created",
      entityType: "room",
      entityId: created!.id,
      description: `Room ${created!.roomNumber} created`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, created, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown";
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return fail(res, 409, "DUPLICATE_ROOM", "Room number already exists");
    }
    throw err;
  }
});

router.put("/:id", requireAuth, requirePermission("edit_rooms"), validate(roomUpdateSchema), async (req, res) => {
  const id = req.params.id!;
  const input = req.body;
  const update: Record<string, unknown> = { ...input, updatedAt: new Date() };
  if (input.baseRate !== undefined) update.baseRate = String(input.baseRate);

  const [updated] = await db.update(rooms).set(update).where(eq(rooms.id, id)).returning();
  if (!updated) return fail(res, 404, "NOT_FOUND", "Room not found");

  await logActivity({
    action: "room_updated",
    entityType: "room",
    entityId: id,
    description: `Room ${updated.roomNumber} updated`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  return ok(res, updated);
});

router.patch(
  "/:id/status",
  requireAuth,
  validate(roomStatusUpdateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { status, reason } = req.body as { status: string; reason?: string };
    const [updated] = await db
      .update(rooms)
      .set({ status: status as never, updatedAt: new Date() })
      .where(eq(rooms.id, id))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Room not found");

    await logActivity({
      action: "room_status_change",
      entityType: "room",
      entityId: id,
      description: `Room ${updated.roomNumber} → ${status}${reason ? ` (${reason})` : ""}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { status, reason },
    });
    await invalidateDashboard();
    return ok(res, updated);
  },
);

// Preview the impact of deleting a room — counts past reservations that
// reference it and reports whether the room is currently occupied or in any
// active reservation. The web UI uses this to render a confirm dialog before
// firing the destructive call.
router.get("/:id/delete-impact", requireAuth, requirePermission("edit_rooms"), async (req, res) => {
  const id = req.params.id!;
  const [room] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  if (!room) return fail(res, 404, "NOT_FOUND", "Room not found");

  // Total historical reservations that have ever held this room.
  const [{ total = 0 } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(reservationRooms)
    .where(eq(reservationRooms.roomId, id));

  // Active reservations (confirmed or checked-in) — these would block deletion.
  const activeRows = await db
    .select({
      reservationId: reservations.id,
      reservationNumber: reservations.reservationNumber,
      status: reservations.status,
      checkInDate: reservations.checkInDate,
      checkOutDate: reservations.checkOutDate,
    })
    .from(reservationRooms)
    .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
    .where(
      and(
        eq(reservationRooms.roomId, id),
        inArray(reservations.status, ["confirmed", "checked_in"]),
      ),
    );

  return ok(res, {
    room: { id: room.id, roomNumber: room.roomNumber, status: room.status },
    totalHistoricalReservations: total,
    activeReservations: activeRows,
    canDelete: activeRows.length === 0 && room.status !== "occupied",
  });
});

// Hard delete a room. Cascades to reservation_rooms (historical links are
// detached). Blocked if the room is currently occupied or attached to an
// active reservation — admin must close those out first.
router.delete("/:id", requireAuth, requirePermission("edit_rooms"), async (req, res) => {
  const id = req.params.id!;
  const [room] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  if (!room) return fail(res, 404, "NOT_FOUND", "Room not found");

  if (room.status === "occupied") {
    return fail(
      res,
      409,
      "ROOM_OCCUPIED",
      `Room ${room.roomNumber} is currently occupied. Check the guest out first.`,
    );
  }

  const activeCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reservationRooms)
    .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
    .where(
      and(
        eq(reservationRooms.roomId, id),
        inArray(reservations.status, ["confirmed", "checked_in"]),
      ),
    );
  if ((activeCount[0]?.n ?? 0) > 0) {
    return fail(
      res,
      409,
      "ROOM_IN_USE",
      `Room ${room.roomNumber} is attached to ${activeCount[0]!.n} active reservation(s). Cancel or check them out first.`,
    );
  }

  const detached = await db.transaction(async (tx) => {
    // Detach all historical reservation_rooms rows for this room, then drop
    // the room itself. The FK is RESTRICT by default, so we have to clear
    // children explicitly inside the same tx.
    const removed = await tx
      .delete(reservationRooms)
      .where(eq(reservationRooms.roomId, id))
      .returning({ id: reservationRooms.id });
    await tx.delete(rooms).where(eq(rooms.id, id));
    return removed.length;
  });

  await logActivity({
    action: "room_deleted",
    entityType: "room",
    entityId: id,
    description: `Room ${room.roomNumber} deleted (${detached} historical reservation link${detached === 1 ? "" : "s"} detached)`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
    metadata: { roomNumber: room.roomNumber, detachedHistoricalLinks: detached },
  });
  await invalidateDashboard();
  return ok(res, { id, deleted: true, detachedHistoricalLinks: detached });
});

export default router;

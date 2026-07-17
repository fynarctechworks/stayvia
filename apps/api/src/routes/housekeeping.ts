import { and, eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { maintenanceIssues } from "../db/schema/maintenance.js";
import { rooms } from "../db/schema/rooms.js";
import { logActivity } from "../lib/activity.js";
import { invalidateDashboard } from "../lib/redis.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const statusUpdate = z.object({
  status: z.enum(["dirty", "available"]),
  reason: z.string().max(500).optional(),
  // Kept for backwards-compat with older clients. The single-step
  // workflow makes it redundant (every dirty → available IS a direct
  // ready), but accepting the flag avoids breaking any callers that
  // still send it.
  directReady: z.boolean().optional(),
});

const maintenanceFlag = z.object({
  reason: z.string().min(1).max(500),
});

const notesUpdate = z.object({
  notes: z.string().max(500).nullable(),
});

router.get("/", requireAuth, async (req, res) => {
  const { floor, status } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (floor !== undefined) conditions.push(eq(rooms.floor, Number(floor)));
  if (status) conditions.push(eq(rooms.status, status as never));
  const rows = await db
    .select()
    .from(rooms)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(rooms.floor, rooms.roomNumber);

  // Per-room open-issue counts so the housekeeping card can render a
  // small "N issues" pill without N+1 round-trips. Open + in_progress
  // = actionable work; resolved + cancelled are excluded.
  const roomIds = rows.map((r) => r.id);
  const issueCounts = roomIds.length
    ? await db
        .select({
          roomId: maintenanceIssues.roomId,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(maintenanceIssues)
        .where(
          and(
            inArray(maintenanceIssues.roomId, roomIds),
            inArray(maintenanceIssues.status, ["open", "in_progress"]),
          ),
        )
        .groupBy(maintenanceIssues.roomId)
    : [];
  const countMap = new Map(
    issueCounts.map((c) => [c.roomId, Number(c.count)]),
  );

  return ok(
    res,
    rows.map((r) => ({
      ...r,
      openIssueCount: countMap.get(r.id) ?? 0,
    })),
  );
});

router.patch("/:roomId", requireAuth, validate(statusUpdate), async (req, res) => {
  const roomId = req.params.roomId!;
  const { status, reason } = req.body as {
    status: string;
    reason?: string;
  };

  const current = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!current.length) return fail(res, 404, "NOT_FOUND", "Room not found");
  const room = current[0]!;

  // Single-step cleaning workflow: dirty rooms become available in
  // one hop. The inspection chain (clean → inspected → available)
  // was removed in migration 0034; the only valid transitions left
  // are the operational ones around occupancy + maintenance.
  const validTransitions: Record<string, string[]> = {
    dirty: ["available", "maintenance"],
    available: ["dirty", "maintenance"],
    occupied: [],
    reserved: [],
    maintenance: ["available", "dirty"],
  };
  const allowed = validTransitions[room.status] ?? [];
  if (!allowed.includes(status)) {
    return fail(
      res,
      409,
      "INVALID_TRANSITION",
      `Cannot transition ${room.status} → ${status}`,
    );
  }

  const [updated] = await db
    .update(rooms)
    .set({ status: status as never, updatedAt: new Date() })
    .where(eq(rooms.id, roomId))
    .returning();

  await logActivity({
    action: "housekeeping_update",
    entityType: "room",
    entityId: roomId,
    description: `Room ${updated!.roomNumber}: ${room.status} → ${status}${reason ? ` (${reason})` : ""}`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  await invalidateDashboard();
  return ok(res, updated);
});

router.post(
  "/:roomId/maintenance",
  requireAuth,
  requirePermission("flag_maintenance"),
  validate(maintenanceFlag),
  async (req, res) => {
    const roomId = req.params.roomId!;
    const { reason } = req.body as { reason: string };
    const [updated] = await db
      .update(rooms)
      .set({ status: "maintenance", notes: reason, updatedAt: new Date() })
      .where(eq(rooms.id, roomId))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Room not found");

    await logActivity({
      action: "maintenance_flagged",
      entityType: "room",
      entityId: roomId,
      description: `Room ${updated.roomNumber} flagged: ${reason}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    await invalidateDashboard();
    return ok(res, updated);
  },
);

router.patch("/:roomId/notes", requireAuth, validate(notesUpdate), async (req, res) => {
  const roomId = req.params.roomId!;
  const { notes } = req.body as { notes: string | null };
  const trimmed = notes && notes.trim() ? notes.trim() : null;

  const [updated] = await db
    .update(rooms)
    .set({ notes: trimmed, updatedAt: new Date() })
    .where(eq(rooms.id, roomId))
    .returning();
  if (!updated) return fail(res, 404, "NOT_FOUND", "Room not found");

  await logActivity({
    action: trimmed ? "room_note_updated" : "room_note_cleared",
    entityType: "room",
    entityId: roomId,
    description: trimmed
      ? `Room ${updated.roomNumber} note: ${trimmed}`
      : `Room ${updated.roomNumber} note cleared`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  await invalidateDashboard();
  return ok(res, updated);
});

router.post("/:roomId/resolve", requireAuth, requirePermission("resolve_maintenance"), async (req, res) => {
  const roomId = req.params.roomId!;
  const [updated] = await db
    .update(rooms)
    .set({ status: "dirty", updatedAt: new Date() })
    .where(eq(rooms.id, roomId))
    .returning();
  if (!updated) return fail(res, 404, "NOT_FOUND", "Room not found");

  await logActivity({
    action: "maintenance_resolved",
    entityType: "room",
    entityId: roomId,
    description: `Room ${updated.roomNumber} maintenance resolved`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  await invalidateDashboard();
  return ok(res, updated);
});

export default router;

// Guest requests — the staff queue behind the in-room QR service tiles.
//
// A guest scans the sticker in their room, unlocks with their phone's last 4
// digits and taps "Clean my room" / "Towels, water & amenities" / "Report a
// problem". That POST lands in routes/qr.ts (public, token-scoped) and writes
// a guest_requests row. This file is everything staff do with it afterwards:
// read the queue, and acknowledge / finish / cancel it.
//
// NOT "Booking Requests" (/requests), which is QR self-booking holds on
// `reservations`. Different table, different page (/guest-requests).
//
// A guest request is a guest *communication*, not a work order: it carries the
// guest's own wording, so the queue never overwrites `note` — see
// guestRequestUpdateSchema in @stayvia/shared, which accepts `status` and
// nothing else.
//
// This module used to let staff promote a request into a housekeeping task or
// maintenance issue (POST /:id/convert). The UI dropped that flow (commit
// ddea776) and nothing calls the route any more, so it was removed here too.
// The three link columns on guest_requests (housekeeping_task_id,
// maintenance_issue_id, maintenance_ticket_id) and their partial unique
// indexes are untouched — dropping them is a destructive migration, not a
// route change — so requestColumns below still selects the first two for
// display: the web page renders a link for requests that were converted
// before this removal.
//
// ---------------------------------------------------------------------------
// TENANCY
// ---------------------------------------------------------------------------
// Every statement in this file — reads and the status PATCH — is scoped by
// req.propertyId, which requireAuth stamps from the caller's own profile and
// no client input can reach. The single loader below (loadRequest) is the
// ONLY way a row is fetched by id, and it takes propertyId as a required
// argument, so "forgot the tenant filter" is a compile error rather than a
// cross-tenant leak. `:id` is never used in a WHERE clause without it.
//
// ---------------------------------------------------------------------------
// PERMISSIONS
// ---------------------------------------------------------------------------
// No new permission key: adding one to lib/permissions.ts needs a migration to
// seed it into every hotel's role_permissions, and this feature is served
// exactly by the existing housekeeping keys.
//   read    → view_housekeeping   (admin, frontdesk, housekeeping, manager,
//                                  owner. Accountant is correctly excluded.)
//   write   → update_housekeeping (the same minus owner, which is read-only)

import {
  GUEST_REQUEST_TERMINAL_STATUSES,
  guestRequestListQuerySchema,
  guestRequestUpdateSchema,
  type GuestRequestUpdateInput,
} from "@stayvia/shared";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import { guestRequests } from "../db/schema/guestRequests.js";
import { guests } from "../db/schema/guests.js";
import { profiles } from "../db/schema/profiles.js";
import { reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { logActivity } from "../lib/activity.js";
import { fail, list, ok } from "../lib/response.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// --------------------------------------------------------------- shaping

// One row of the queue, joined out for display. Left joins on room /
// reservation / guest because reservation_id and guest_id are nullable by
// design (a DPDP purge of the stay must not take the hotel's service history
// with it), so a request can outlive both.
const requestColumns = {
  id: guestRequests.id,
  kind: guestRequests.kind,
  status: guestRequests.status,
  note: guestRequests.note,
  createdAt: guestRequests.createdAt,
  acknowledgedAt: guestRequests.acknowledgedAt,
  acknowledgedBy: guestRequests.acknowledgedBy,
  completedAt: guestRequests.completedAt,
  completedBy: guestRequests.completedBy,
  roomId: guestRequests.roomId,
  roomNumber: rooms.roomNumber,
  roomType: rooms.roomType,
  floor: rooms.floor,
  reservationId: guestRequests.reservationId,
  reservationNumber: reservations.reservationNumber,
  guestId: guestRequests.guestId,
  guestName: guests.fullName,
  housekeepingTaskId: guestRequests.housekeepingTaskId,
  maintenanceIssueId: guestRequests.maintenanceIssueId,
};

// Resolves the two profile stamps to names in one round-trip for a page of
// rows. Kept out of the main query because acknowledged_by and completed_by
// are two nullable FKs to the same table — joining both would need two more
// aliased joins for two strings.
async function attachStaffNames<
  T extends { acknowledgedBy: string | null; completedBy: string | null },
>(rows: T[], propertyId: string) {
  const ids = Array.from(
    new Set(
      rows.flatMap((r) => [r.acknowledgedBy, r.completedBy]).filter((v): v is string => !!v),
    ),
  );
  const staff = ids.length
    ? await db
        .select({ id: profiles.id, fullName: profiles.fullName })
        .from(profiles)
        // Scoped even though the ids came from our own hotel's rows: a
        // profile that moved hotels must not leak its name back here.
        .where(and(inArray(profiles.id, ids), eq(profiles.propertyId, propertyId)))
    : [];
  const byId = new Map(staff.map((p) => [p.id, p.fullName]));
  return rows.map((r) => ({
    ...r,
    acknowledgedByName: r.acknowledgedBy ? byId.get(r.acknowledgedBy) ?? null : null,
    completedByName: r.completedBy ? byId.get(r.completedBy) ?? null : null,
  }));
}

// A non-uuid :id reaches Postgres as a cast error (22P02) and comes back a
// 500, which turns id-guessing probes into noise in the error log. Answer them
// the same way a wrong-but-well-formed id is answered: 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// THE ONLY by-id fetch in this file. propertyId is a required parameter, so
// there is no call site that can accidentally omit the tenant filter.
async function loadRequest(id: string, propertyId: string) {
  if (!UUID_RE.test(id)) return null;
  const rows = await db
    .select(requestColumns)
    .from(guestRequests)
    .innerJoin(rooms, eq(rooms.id, guestRequests.roomId))
    .leftJoin(reservations, eq(reservations.id, guestRequests.reservationId))
    .leftJoin(guests, eq(guests.id, guestRequests.guestId))
    .where(and(eq(guestRequests.id, id), eq(guestRequests.propertyId, propertyId)))
    .limit(1);
  if (!rows.length) return null;
  const [detail] = await attachStaffNames(rows, propertyId);
  return detail ?? null;
}

// The raw row — needed by the mutating handler, which has to read the
// current status before deciding anything.
async function loadRequestRow(id: string, propertyId: string) {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select()
    .from(guestRequests)
    .where(and(eq(guestRequests.id, id), eq(guestRequests.propertyId, propertyId)))
    .limit(1);
  return row ?? null;
}

const isTerminal = (status: string) =>
  (GUEST_REQUEST_TERMINAL_STATUSES as readonly string[]).includes(status);

// -------------------------------------------------------------------- list

// GET /guest-requests — the queue. Newest first.
//
// The sidebar badge is this endpoint with `?statuses=open,acknowledged&
// per_page=1`, reading meta.total (same trick the Booking Requests badge
// uses against /reservations).
router.get(
  "/",
  requireAuth,
  requirePermission("view_housekeeping"),
  validate(guestRequestListQuerySchema, "query"),
  async (req, res) => {
    const { status, statuses, kind, room_id, reservation_id, page, per_page } =
      guestRequestListQuerySchema.parse(req.query);

    // propertyId first and unconditionally. Every other condition is additive.
    const conditions = [eq(guestRequests.propertyId, req.propertyId)];
    if (status) conditions.push(eq(guestRequests.status, status));
    // Already decoded and enum-validated by the shared schema — do not split
    // this string here (see the note on guestRequestListQuerySchema).
    if (statuses) conditions.push(inArray(guestRequests.status, statuses));
    if (kind) conditions.push(eq(guestRequests.kind, kind));
    if (room_id) conditions.push(eq(guestRequests.roomId, room_id));
    if (reservation_id) conditions.push(eq(guestRequests.reservationId, reservation_id));

    const where = and(...conditions);
    const offset = (page - 1) * per_page;

    const [rows, totalRows] = await Promise.all([
      db
        .select(requestColumns)
        .from(guestRequests)
        .innerJoin(rooms, eq(rooms.id, guestRequests.roomId))
        .leftJoin(reservations, eq(reservations.id, guestRequests.reservationId))
        .leftJoin(guests, eq(guests.id, guestRequests.guestId))
        .where(where)
        // Matches idx_guest_requests_queue (property_id, status, created_at
        // DESC) — the filtered queue reads straight off the index. `id` is a
        // tiebreaker only: two guests tapping in the same microsecond would
        // otherwise give an unstable sort, which duplicates or drops rows
        // across page boundaries.
        .orderBy(desc(guestRequests.createdAt), desc(guestRequests.id))
        .limit(per_page)
        .offset(offset),
      db.select({ count: count() }).from(guestRequests).where(where),
    ]);

    const items = await attachStaffNames(rows, req.propertyId);
    return list(res, items, { total: totalRows[0]?.count ?? 0, page, per_page });
  },
);

router.get("/:id", requireAuth, requirePermission("view_housekeeping"), async (req, res) => {
  const detail = await loadRequest(req.params.id!, req.propertyId);
  if (!detail) return fail(res, 404, "NOT_FOUND", "Request not found");
  return ok(res, detail);
});

// ------------------------------------------------------------ status patch

// PATCH /guest-requests/:id — [Acknowledge] / [Mark done] / [Cancel].
//
// `status` is the only writable field. `open` is not an accepted target (the
// shared schema rejects it): it is set once by the guest-side insert, and
// writing it back would resurrect a finished request while leaving a stale
// completed_at/completed_by on the row. A guest who still needs something taps
// the tile again, which is a new request with its own timestamp.
router.patch(
  "/:id",
  requireAuth,
  requirePermission("update_housekeeping"),
  validate(guestRequestUpdateSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { status } = req.body as GuestRequestUpdateInput;

    const before = await loadRequestRow(id, req.propertyId);
    if (!before) return fail(res, 404, "NOT_FOUND", "Request not found");

    // Re-sending the status a request already has is a no-op, not an error —
    // double-taps on a phone are the normal case here.
    if (before.status === status) {
      return ok(res, await loadRequest(id, req.propertyId));
    }
    // done and cancelled are final. Reopening would leave the completion
    // stamps pointing at a request that is live again.
    if (isTerminal(before.status)) {
      return fail(
        res,
        409,
        "ALREADY_CLOSED",
        `This request is already ${before.status} and cannot be changed.`,
      );
    }

    const now = new Date();
    const patch: Partial<typeof guestRequests.$inferInsert> = { status };
    // Whoever first touches the request owns the acknowledgement, including
    // someone who skips straight to done — otherwise the row records a
    // completion with nobody having ever picked it up.
    if (!before.acknowledgedAt) {
      patch.acknowledgedAt = now;
      patch.acknowledgedBy = req.user!.id;
    }
    if (isTerminal(status)) {
      patch.completedAt = now;
      patch.completedBy = req.user!.id;
    }

    await db
      .update(guestRequests)
      .set(patch)
      .where(and(eq(guestRequests.id, id), eq(guestRequests.propertyId, req.propertyId)));

    await logActivity({
      propertyId: req.propertyId,
      action: "guest_request_updated",
      entityType: "guest_request",
      entityId: id,
      description: `Guest request (${before.kind}): ${before.status} → ${status}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    return ok(res, await loadRequest(id, req.propertyId));
  },
);

export default router;

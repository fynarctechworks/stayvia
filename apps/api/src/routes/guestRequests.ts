// Guest requests — the staff queue behind the in-room QR service tiles.
//
// A guest scans the sticker in their room, unlocks with their phone's last 4
// digits and taps "Clean my room" / "Towels, water & amenities" / "Report a
// problem". That POST lands in routes/qr.ts (public, token-scoped) and writes
// a guest_requests row. This file is everything staff do with it afterwards:
// read the queue, acknowledge / finish / cancel, and promote a request into
// the real work modules.
//
// NOT "Booking Requests" (/requests), which is QR self-booking holds on
// `reservations`. Different table, different page (/guest-requests).
//
// A guest request is a guest *communication*, not a work order: it carries the
// guest's own wording, so the queue never overwrites `note` — see
// guestRequestUpdateSchema in @stayvia/shared, which accepts `status` and
// nothing else.
//
// ---------------------------------------------------------------------------
// TENANCY
// ---------------------------------------------------------------------------
// Every statement in this file — reads, the status PATCH, the convert insert,
// the convert's room/reservation lookups and the compensating re-read — is
// scoped by req.propertyId, which requireAuth stamps from the caller's own
// profile and no client input can reach. The single loader below
// (loadRequest) is the ONLY way a row is fetched by id, and it takes
// propertyId as a required argument, so "forgot the tenant filter" is a
// compile error rather than a cross-tenant leak. `:id` is never used in a
// WHERE clause without it.
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
//   convert → update_housekeeping, plus manage_maintenance checked in-handler
//             for the maintenance target, because that branch creates a row in
//             someone else's module.

import {
  GUEST_REQUEST_KIND_CONVERT_TARGET,
  GUEST_REQUEST_TERMINAL_STATUSES,
  guestRequestConvertSchema,
  guestRequestListQuerySchema,
  guestRequestUpdateSchema,
  type GuestRequestConvertInput,
  type GuestRequestUpdateInput,
} from "@stayvia/shared";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../db/client.js";
import { guestRequests } from "../db/schema/guestRequests.js";
import { guests } from "../db/schema/guests.js";
import { housekeepingTasks } from "../db/schema/housekeeping.js";
import { maintenanceIssues } from "../db/schema/maintenance.js";
import { profiles } from "../db/schema/profiles.js";
import { reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { logActivity } from "../lib/activity.js";
import { logger } from "../lib/logger.js";
import { dispatchNotification } from "../lib/notify.js";
import { hasPermission } from "../lib/permission-resolver.js";
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

// The raw row — needed by the mutating handlers, which have to read the
// current status and the existing conversion links before deciding anything.
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

// ----------------------------------------------------------------- convert

// Thrown inside the convert transaction when the conditional UPDATE matches
// zero rows, i.e. a concurrent request converted this one first. Rolling the
// transaction back discards the work item we just inserted, so the loser of
// the race leaves nothing behind and the caller gets the winner's link.
const LOST_CONVERT_RACE = "GUEST_REQUEST_CONVERT_RACE";

// POST /guest-requests/:id/convert — promote a request into a real work item.
//
//   cleaning → housekeeping_tasks     issue → maintenance_issues
//   amenity  → nothing; acknowledge / done only (400)
//
// Idempotent by construction, at three levels:
//   1. an already-linked request returns its existing link (200, no insert);
//   2. the link is claimed by `UPDATE ... WHERE <link> IS NULL`, and a loser
//      rolls its whole transaction back;
//   3. partial UNIQUE indexes on each link column (migration 0015) make
//      "one work item per request" a database invariant, so anything that
//      slipped past 1 and 2 fails loudly instead of minting a second task.
//
// The payload carries NO room_id / reservation_id / property_id. All three
// come off the stored row: taking a room from the client would let hotel B
// file work against hotel A's room.
router.post(
  "/:id/convert",
  requireAuth,
  requirePermission("update_housekeeping"),
  validate(guestRequestConvertSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as GuestRequestConvertInput;

    const request = await loadRequestRow(id, req.propertyId);
    if (!request) return fail(res, 404, "NOT_FOUND", "Request not found");

    // The target is decided by the STORED kind, never by the payload — the
    // payload only says which shape of context it brought.
    const expected = GUEST_REQUEST_KIND_CONVERT_TARGET[request.kind];
    if (!expected) {
      return fail(
        res,
        400,
        "NOT_CONVERTIBLE",
        "An amenity request has no work module. Acknowledge it or mark it done once the item is delivered.",
      );
    }
    if (expected !== input.target) {
      return fail(
        res,
        400,
        "WRONG_TARGET",
        `A ${request.kind} request converts to ${expected}, not ${input.target}.`,
      );
    }
    // Converting something the desk already closed would file work nobody
    // asked for any more.
    if (isTerminal(request.status)) {
      return fail(
        res,
        409,
        "ALREADY_CLOSED",
        `This request is already ${request.status} and cannot be converted.`,
      );
    }

    // The route gate is update_housekeeping; filing into someone else's module
    // needs that module's own key. Checked before any business logic so the
    // answer does not depend on how far the request happens to get.
    if (input.target === "maintenance" && !hasPermission(req.user!, "manage_maintenance")) {
      return fail(res, 403, "FORBIDDEN", "Requires permission: manage_maintenance");
    }

    // (1) Already converted → hand back the existing link. Converting twice
    // must not create a second task.
    const existingLink =
      input.target === "maintenance" ? request.maintenanceIssueId : request.housekeepingTaskId;
    if (existingLink) {
      return ok(res, {
        alreadyConverted: true,
        target: input.target,
        workItemId: existingLink,
        request: await loadRequest(id, req.propertyId),
      });
    }

    // The room is re-verified against THIS hotel even though it came off our
    // own tenant-scoped row — the work item's property_id is written from
    // req.propertyId and the two must be the same hotel.
    const [room] = await db
      .select({ id: rooms.id, roomNumber: rooms.roomNumber })
      .from(rooms)
      .where(and(eq(rooms.id, request.roomId), eq(rooms.propertyId, req.propertyId)))
      .limit(1);
    if (!room) return fail(res, 404, "NOT_FOUND", "Room not found");

    // The stay, if the request is still linked to one and it is still ours.
    // Nullable on purpose: reservation_id is SET NULL on purge, and a stale
    // link must not block the conversion.
    let reservationId: string | null = null;
    if (request.reservationId) {
      const [stay] = await db
        .select({ id: reservations.id })
        .from(reservations)
        .where(
          and(
            eq(reservations.id, request.reservationId),
            eq(reservations.propertyId, req.propertyId),
          ),
        )
        .limit(1);
      reservationId = stay?.id ?? null;
    }

    const now = new Date();
    let workItemId: string;
    try {
      workItemId = await db.transaction(async (tx) => {
        let createdId: string;

        if (input.target === "maintenance") {
          // maintenance_issues, NOT maintenance_tickets — see the note at the
          // bottom of this file.
          const [issue] = await tx
            .insert(maintenanceIssues)
            .values({
              propertyId: req.propertyId,
              roomId: room.id,
              category: input.category,
              severity: input.severity,
              title: input.title,
              description: input.description,
              costEstimate: input.costEstimate?.toString() ?? null,
              // The staff member who converted is the reporter: reported_by is
              // NOT NULL and FKs to profiles, and the actual reporter is a
              // guest with no profile row. The guest's own words survive on
              // the guest_requests row this issue links back to.
              reportedBy: req.user!.id,
            })
            .returning({ id: maintenanceIssues.id });
          createdId = issue!.id;
        } else {
          // daily_refresh, not checkout_clean: the guest is mid-stay and
          // asking for a tidy-up, which is not a turnover.
          const [task] = await tx
            .insert(housekeepingTasks)
            .values({
              propertyId: req.propertyId,
              roomId: room.id,
              reservationId,
              taskType: "daily_refresh",
              status: "pending",
              // Above the 50 default: a guest is actively waiting on this one,
              // unlike the routine turnover queue. Well inside the 0..100 CHECK.
              priority: 60,
              notes: [request.note?.trim(), input.notes?.trim()].filter(Boolean).join(" — ") || null,
              createdBy: req.user!.id,
            })
            .returning({ id: housekeepingTasks.id });
          createdId = task!.id;
        }

        // (2) Claim the link. `IS NULL` is what makes this idempotent; the
        // property_id term is what makes it tenant-safe. A concurrent convert
        // that committed first blocks us on the row lock, then re-checks the
        // predicate against the new row version and matches nothing.
        const claimed = await tx
          .update(guestRequests)
          .set({
            ...(input.target === "maintenance"
              ? { maintenanceIssueId: createdId }
              : { housekeepingTaskId: createdId }),
            // Converting IS acknowledging.
            status: "acknowledged",
            ...(request.acknowledgedAt
              ? {}
              : { acknowledgedAt: now, acknowledgedBy: req.user!.id }),
          })
          .where(
            and(
              eq(guestRequests.id, id),
              eq(guestRequests.propertyId, req.propertyId),
              input.target === "maintenance"
                ? isNull(guestRequests.maintenanceIssueId)
                : isNull(guestRequests.housekeepingTaskId),
              // Do not un-close a request that was completed between our read
              // and this write.
              sql`${guestRequests.status} NOT IN ('done', 'cancelled')`,
            ),
          )
          .returning({ id: guestRequests.id });

        if (!claimed.length) throw new Error(LOST_CONVERT_RACE);
        return createdId;
      });
    } catch (err) {
      if (err instanceof Error && err.message === LOST_CONVERT_RACE) {
        // The work item we inserted rolled back with the transaction. Read
        // the winner's link and return that.
        const winner = await loadRequestRow(id, req.propertyId);
        const link =
          input.target === "maintenance"
            ? winner?.maintenanceIssueId
            : winner?.housekeepingTaskId;
        if (!link) {
          // Not the race, then — the request was closed under us.
          return fail(
            res,
            409,
            "ALREADY_CLOSED",
            "This request was closed while you were converting it.",
          );
        }
        logger.info({ guestRequestId: id, target: input.target }, "convert lost the race");
        return ok(res, {
          alreadyConverted: true,
          target: input.target,
          workItemId: link,
          request: await loadRequest(id, req.propertyId),
        });
      }
      throw err;
    }

    await logActivity({
      propertyId: req.propertyId,
      action:
        input.target === "maintenance"
          ? "guest_request_converted_maintenance"
          : "guest_request_converted_housekeeping",
      entityType: "guest_request",
      entityId: id,
      description:
        input.target === "maintenance"
          ? `Room ${room.roomNumber}: guest request → maintenance issue "${input.title}"`
          : `Room ${room.roomNumber}: guest request → housekeeping task`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { target: input.target, workItemId },
    });

    // Housekeeping tasks have no page of their own yet, so without this the
    // task would exist and nobody would be told. Maintenance issues do have
    // one (/maintenance/:id), but the ping is worth the same either way.
    await dispatchNotification({
      propertyId: req.propertyId,
      type: "system",
      title:
        input.target === "maintenance"
          ? `Room ${room.roomNumber}: maintenance issue raised`
          : `Room ${room.roomNumber}: cleaning requested`,
      body:
        input.target === "maintenance"
          ? input.title
          : request.note?.trim() || "The guest asked for their room to be cleaned.",
      href: input.target === "maintenance" ? `/maintenance/${workItemId}` : "/guest-requests",
      recipientRoles:
        input.target === "maintenance"
          ? ["admin", "frontdesk"]
          : ["admin", "frontdesk", "housekeeping"],
    });

    return ok(
      res,
      {
        alreadyConverted: false,
        target: input.target,
        workItemId,
        request: await loadRequest(id, req.propertyId),
      },
      201,
    );
  },
);

// ---------------------------------------------------------------------------
// Why maintenance_issues and not maintenance_tickets
// ---------------------------------------------------------------------------
// The brief named `maintenance_tickets` for the `issue` conversion. This route
// writes `maintenance_issues` instead, deliberately:
//
//   * maintenance_issues is the LIVE module — routes/maintenance.ts and
//     pages/MaintenanceDetail.tsx. A converted request shows up on the
//     Maintenance page immediately.
//   * maintenance_tickets has zero code references anywhere in the repo (it is
//     the dormant Phase-2 revenue-ops table). A row written there is visible on
//     no screen in the product.
//   * The two tables do not even share a vocabulary: maintenance_tickets.
//     category is the pg enum maintenance_category (plumbing, ac_heating,
//     tv_internet, locks_safety, …) while maintenance_issues.category is a
//     CHECK-constrained text column with a different list (ac_hvac, fixtures,
//     cleanliness, structural, …). The shared contract validates against
//     MAINTENANCE_CATEGORIES, which is the issues list, so writing a ticket
//     would need a lossy category translation on top of everything else.
//   * ticket_number is NOT NULL and per-hotel, and there is no
//     'maintenance_ticket' key in DOC_COUNTERS and no formatter in
//     lib/numbers.ts. Adding both to mint numbers for rows no page can read
//     would be inventing numbering for a dead table.
//
// guest_requests keeps a spare maintenance_ticket_id column (migration 0015)
// for whenever that module is revived. Reviving it is a new convert target,
// not a change to this one.

export default router;

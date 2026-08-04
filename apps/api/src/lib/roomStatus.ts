import { and, eq, inArray, ne } from "drizzle-orm";
import type { db } from "../db/client.js";
import { reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";

type ReleaseTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Valid physical room-status transitions.
//
// Shared by the housekeeping board (PATCH /housekeeping/:roomId) and the rooms
// admin endpoint (PATCH /rooms/:id/status) so the two cannot drift. They did:
// housekeeping enforced this map while the rooms endpoint wrote `status`
// straight through, so a caller could move an OCCUPIED room to 'available'
// and desync the board from the reservation that still holds it.
//
// `occupied` and `reserved` are terminal on purpose — a room leaves those
// states through the reservation lifecycle (check-in / check-out / cancel),
// never by someone editing a status dropdown.
export const ROOM_STATUS_TRANSITIONS: Record<string, string[]> = {
  dirty: ["available", "maintenance"],
  available: ["dirty", "maintenance"],
  occupied: [],
  reserved: [],
  maintenance: ["available", "dirty"],
};

export function canTransitionRoomStatus(from: string, to: string): boolean {
  // A no-op write is always fine — it keeps retries and idempotent clients
  // from tripping a 409 on a status the room already has.
  if (from === to) return true;
  return (ROOM_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

// Release the rooms a reservation was holding, WITHOUT stealing a room that
// another booking still holds.
//
// The naive `update(rooms).set({status:'available'}).where(inArray(id, roomIds))`
// that cancel/no-show used had no idea whose occupancy it was overwriting. Room
// 101 checked-in to guest B and separately booked by guest A for next week reads
// 'occupied'; cancelling A wrote 'available' over it. From there the room is
// clean and free on the board while a guest is inside, and — on B's departure
// day, before check-out — findAvailableRooms stops excluding it (it only drops
// maintenance/occupied for a window that includes today) while findRoomConflicts
// sees no overlap with B's half-open [.., today) range, so the desk can sell an
// occupied room. That is exactly the desync the transition map at the top of
// this file exists to make unreachable.
//
// Per room, the status is therefore DERIVED from who is left holding it:
//   • another reservation is checked_in on it  → leave it alone (occupied).
//   • another live booking holds it            → 'reserved'.
//   • nobody                                   → the caller's target.
// A room in 'maintenance' is never touched: it is out of service for a reason
// that has nothing to do with this booking, and cancelling a stay must not
// quietly return it to inventory.
export async function releaseRoomsFromReservation(
  tx: ReleaseTx,
  args: {
    propertyId: string;
    reservationId: string;
    roomIds: string[];
    // 'dirty' when the guest physically used the room (cancelling a checked-in
    // stay), 'available' when they never arrived (confirmed cancel / no-show).
    target: "available" | "dirty";
  },
): Promise<void> {
  if (args.roomIds.length === 0) return;

  const holders = await tx
    .select({
      roomId: reservationRooms.roomId,
      status: reservations.status,
    })
    .from(reservationRooms)
    .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
    .where(
      and(
        inArray(reservationRooms.roomId, args.roomIds),
        ne(reservationRooms.reservationId, args.reservationId),
        ne(reservationRooms.status, "cancelled"),
        eq(reservations.propertyId, args.propertyId),
        inArray(reservations.status, [
          "hold",
          "pending_payment",
          "confirmed",
          "checked_in",
        ]),
      ),
    );

  const occupiedByOther = new Set<string>();
  const heldByOther = new Set<string>();
  for (const h of holders) {
    if (h.status === "checked_in") occupiedByOther.add(h.roomId);
    else heldByOther.add(h.roomId);
  }

  const byTarget = new Map<"available" | "dirty" | "reserved", string[]>();
  for (const roomId of args.roomIds) {
    if (occupiedByOther.has(roomId)) continue;
    const next = heldByOther.has(roomId) ? "reserved" : args.target;
    const list = byTarget.get(next) ?? [];
    list.push(roomId);
    byTarget.set(next, list);
  }

  for (const [status, ids] of byTarget) {
    if (ids.length === 0) continue;
    await tx
      .update(rooms)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(rooms.propertyId, args.propertyId),
          inArray(rooms.id, ids),
          ne(rooms.status, "maintenance"),
        ),
      );
  }
}

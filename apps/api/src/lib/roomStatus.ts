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

import type { QueryClient } from "@tanstack/react-query";

// Centralized cache-invalidation helpers.
//
// React Query caches each useQuery result by its key. After a mutation, every
// page showing a derived view of the same underlying data must drop its cache
// so the next render fetches fresh state. Without this, the user mutates on
// page A, navigates to page B, and sees stale numbers until the staleTime
// expires.
//
// Each function below invalidates the *minimal* set of keys that a given
// mutation could affect — including indirect ones. For example, taking a
// payment touches: the reservation detail, the guest profile, the dashboard
// revenue tile, the collections report, the outstanding report, and the
// reservations list (balance column).
//
// IMPORTANT: query keys here must match the keys passed to useQuery in each
// page. If you rename a key, update both ends.

interface InvalidateOpts {
  reservationId?: string;
  guestId?: string;
}

// Invalidates every key that depends on reservation or money state. Use
// liberally — the cost of an extra refetch is far smaller than the cost of
// showing stale numbers to staff.
export function invalidateReservationData(qc: QueryClient, opts: InvalidateOpts = {}) {
  // Reservation-specific keys
  if (opts.reservationId) {
    qc.invalidateQueries({ queryKey: ["reservation", opts.reservationId] });
  } else {
    qc.invalidateQueries({ queryKey: ["reservation"] });
  }
  qc.invalidateQueries({ queryKey: ["reservations"] });

  // Guest-specific keys
  if (opts.guestId) {
    qc.invalidateQueries({ queryKey: ["guest", opts.guestId] });
    qc.invalidateQueries({ queryKey: ["ledger", opts.guestId] });
  } else {
    qc.invalidateQueries({ queryKey: ["guest"] });
    qc.invalidateQueries({ queryKey: ["ledger"] });
  }
  qc.invalidateQueries({ queryKey: ["guests"] });

  // Money/aggregate views
  qc.invalidateQueries({ queryKey: ["dashboard"] });
  qc.invalidateQueries({ queryKey: ["collections"] });
  qc.invalidateQueries({ queryKey: ["outstanding"] });
  qc.invalidateQueries({ queryKey: ["rpt-out"] });
  qc.invalidateQueries({ queryKey: ["collections-summary"] });
  // Per-guest outstanding (used by NewReservation banner + checkout modal)
  if (opts.guestId) {
    qc.invalidateQueries({ queryKey: ["guest-outstanding", opts.guestId] });
  } else {
    qc.invalidateQueries({ queryKey: ["guest-outstanding"] });
  }

  // Reports — most are cached per-date-range and will refetch lazily anyway,
  // but invalidating ensures the next visit always sees fresh data.
  qc.invalidateQueries({ queryKey: ["rpt-revenue"] });
  qc.invalidateQueries({ queryKey: ["rpt-collections"] });
  qc.invalidateQueries({ queryKey: ["rpt-occupancy"] });
  qc.invalidateQueries({ queryKey: ["rpt-gst"] });
  qc.invalidateQueries({ queryKey: ["rpt-room-perf"] });
  qc.invalidateQueries({ queryKey: ["rpt-credit"] });
  qc.invalidateQueries({ queryKey: ["rpt-guests"] });
}

// Lighter helper for mutations that only touch room state (housekeeping
// transitions, room status changes, room add/edit/delete). Doesn't bother
// invalidating guest/payment caches.
export function invalidateRoomData(qc: QueryClient, opts: { roomId?: string } = {}) {
  qc.invalidateQueries({ queryKey: ["rooms"] });
  if (opts.roomId) qc.invalidateQueries({ queryKey: ["room", opts.roomId] });
  qc.invalidateQueries({ queryKey: ["hk"] });
  qc.invalidateQueries({ queryKey: ["dashboard"] });
  qc.invalidateQueries({ queryKey: ["avail"] });
}

// For mutations that change a guest's profile fields (name/phone/tags) but
// don't touch money. Skips dashboard + reports.
export function invalidateGuestProfile(qc: QueryClient, guestId?: string) {
  if (guestId) {
    qc.invalidateQueries({ queryKey: ["guest", guestId] });
    qc.invalidateQueries({ queryKey: ["kyc", guestId] });
    qc.invalidateQueries({ queryKey: ["guest-notes", guestId] });
    qc.invalidateQueries({ queryKey: ["guest-followups", guestId] });
  } else {
    qc.invalidateQueries({ queryKey: ["guest"] });
  }
  qc.invalidateQueries({ queryKey: ["guests"] });
}

import { differenceInCalendarDays } from "date-fns";

// THE single definition of "how many nights is this room billed for".
//
// Every room-charge total in the app must go through here. It existed inline
// in a handful of places — recalcReservation, invoiceBuilder, the combined
// and per-room checkout branches, the invoice preview — and each copy drifted:
// several multiplied a room's rate by the WHOLE reservation's night count,
// ignoring that a swap leg or a mid-stay added room only covers part of the
// stay. That inflated bills (a 5-night booking billed 3 rooms × 5 nights =
// 15 room-nights instead of the 1+4+1 = 6 the guest actually occupied) and
// made check-out reject the correct payment as an "overpayment".
//
// Keeping it in one function means the reservation total, the invoice, the
// preview and the checkout math cannot disagree again.

export interface RoomSegment {
  // Half-open night window [effectiveFrom, effectiveTo). NULL on either bound
  // means the row covers the whole stay (unsegmented / never swapped).
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface StayWindow {
  checkInDate: string;
  checkOutDate: string;
  // Short-stay (day-use) rooms bill as ONE flat unit — ratePerNight holds the
  // agreed all-in price for the duration, not a per-night rate.
  stayType?: string | null;
}

// Nights a single room row is billed for.
//   - short_stay        → 1 (flat)
//   - segmented row     → nights within its own [effectiveFrom, effectiveTo)
//   - unsegmented row   → the full reservation window
// Never less than 1, mirroring the invoice builder's floor.
export function roomBillableNights(room: RoomSegment, stay: StayWindow): number {
  if (stay.stayType === "short_stay") return 1;
  const from = room.effectiveFrom ?? stay.checkInDate;
  const to = room.effectiveTo ?? stay.checkOutDate;
  return Math.max(1, differenceInCalendarDays(new Date(to), new Date(from)));
}

// Sum of rate × billable nights across every room row, rounded to paise.
// In inclusive mode this is a gross figure, in exclusive it is net — the
// caller runs it through calcGstBreakdown either way. Extra beds and other
// per-night add-ons are the caller's concern; this is room tariff only.
export function sumRoomAmount(
  rooms: Array<RoomSegment & { ratePerNight: string | number }>,
  stay: StayWindow,
): number {
  return +rooms
    .reduce((sum, rm) => sum + Number(rm.ratePerNight) * roomBillableNights(rm, stay), 0)
    .toFixed(2);
}

// THE single definition of "what GST rate does this room row pay, and what do
// all the room rows add up to".
//
// Why this exists:
// Indian hotel GST is slabbed on the ROOM TARIFF PER NIGHT — exempt below
// ₹1,000, the low rate up to ₹7,500, the high rate above (see lib/gst.ts and
// the per-property slab settings). POST /reservations used to average the
// rates across every room on the booking, run that ONE number through
// getGstRate, and snapshot the result on reservations.gst_rate, which the
// invoice builder, both checkout branches, the preview and recalc then applied
// to every line. On a mixed-rate booking (a ₹900 standard plus a ₹9,000 suite
// — an ordinary flow the booking form supports per room) the average landed in
// the middle band, so the suite was taxed at 5% instead of 18% and the ₹900
// room at 5% instead of exempt. Both figures are filed and neither can be
// corrected without a credit note.
//
// reservation_rooms.gst_rate (migration 0016) now carries each room's own
// slab. This module resolves it — falling back to the reservation's snapshot
// for rows written before that migration — and sums the room money at the
// per-row rate, so the reservation total, the invoice and the preview cannot
// disagree about tax the way they used to about nights (see lib/nights.ts).

import { calcGstBreakdown, type GstMode } from "./gst.js";
import { roomBillableNights, type RoomSegment, type StayWindow } from "./nights.js";

export interface TaxableRoomRow extends RoomSegment {
  ratePerNight: string | number;
  // Migration 0016. NULL/undefined on legacy rows → inherit the reservation's
  // snapshotted rate, which is exactly what those rows were billed at.
  gstRate?: string | number | null;
  extraBeds?: number | null;
  extraBedRate?: string | number | null;
}

// The rate a single room row is taxed at. `fallback` is the reservation's
// snapshotted gstRate.
export function roomRowGstRate(
  row: { gstRate?: string | number | null },
  fallback: number,
): number {
  if (row.gstRate === null || row.gstRate === undefined || row.gstRate === "") {
    return fallback;
  }
  const n = Number(row.gstRate);
  return Number.isFinite(n) ? n : fallback;
}

export interface RoomTaxTotals {
  // Net of GST — what goes into reservations.subtotal / invoice line amounts.
  net: number;
  // GST across every room row, each at its own slab.
  gst: number;
  // net + gst.
  gross: number;
}

// Room tariff + extra-bed money for every row, taxed at each row's own slab.
//
// Extra-bed money rides the room's slab and nights (it is part of the room
// tariff) but is deliberately NOT part of the slab DECISION — that is made
// from the room rate alone at booking time, so extra-person money can't push a
// room into a higher band.
export function sumRoomTax(
  rooms: TaxableRoomRow[],
  stay: StayWindow,
  gstMode: GstMode,
  fallbackGstRate: number,
): RoomTaxTotals {
  let net = 0;
  let gst = 0;
  for (const rm of rooms) {
    const units = roomBillableNights(rm, stay);
    const amount =
      Number(rm.ratePerNight) * units +
      Number(rm.extraBeds ?? 0) * Number(rm.extraBedRate ?? 0) * units;
    if (amount === 0) continue;
    const breakdown = calcGstBreakdown(
      +amount.toFixed(2),
      roomRowGstRate(rm, fallbackGstRate),
      gstMode,
    );
    net += breakdown.subtotal;
    gst += breakdown.gstAmount;
  }
  net = +net.toFixed(2);
  gst = +gst.toFixed(2);
  return { net, gst, gross: +(net + gst).toFixed(2) };
}

// The rate to store on reservations.gst_rate / print in the invoice header
// when the rooms don't agree. Uniform bookings (the overwhelming majority)
// keep their single true rate; a mixed booking stores the HIGHEST slab in
// play, because that is the one a headline figure must not understate. The
// per-line rates on the invoice remain the authoritative ones, and every total
// is summed per row via sumRoomTax — the headline is display + the fallback
// for rows that have no slab of their own.
export function headlineGstRate(rates: number[]): number {
  if (rates.length === 0) return 0;
  return rates.reduce((a, b) => (b > a ? b : a), rates[0]!);
}

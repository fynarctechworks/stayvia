// Per-scope invoice builder.
//
// Builds line items + totals for an invoice that covers either:
//   - the FULL reservation (every reservation_room + every charge)
//   - a SUBSET of rooms (per-room invoice — only those rooms, plus
//     additional_charges that target one of those rooms, plus the
//     reservation-wide charges only when this invoice covers the
//     "last" remaining rooms)
//
// All callers go through this so the GST math + line shape are
// identical between the legacy "checkout generates one combined
// invoice" path and the new "per-room invoice" endpoint.

import { combinedRoomTypeLabel, type RoomTypeLabelMap } from "./roomTypeLabel.js";
import { calcGstBreakdown } from "./gst.js";
import { roomBillableNights } from "./nights.js";
import type { AdditionalCharge } from "../db/schema/invoices.js";
import type { ReservationRoom } from "../db/schema/reservations.js";
import type { Room } from "../db/schema/rooms.js";

export interface ReservationLike {
  stayType: "overnight" | "short_stay";
  durationHours: string | null;
  checkInDate: string;
  checkOutDate: string;
  numNights: number;
  gstRate: string;
  gstMode: "exclusive" | "inclusive";
}

export interface BuilderArgs {
  reservation: ReservationLike;
  // The rooms IN SCOPE of this invoice. For combined: every
  // reservation_room. For per-room: just the one (or subset).
  rooms: Array<ReservationRoom & { room: Room }>;
  // Charges to include. The caller decides which charges apply (see
  // selectChargesForScope below).
  charges: AdditionalCharge[];
  // Slug → label map for the displayed "Ac Single Bed Rooms" labels.
  labelMap: RoomTypeLabelMap;
  // room id → room number, so an in-place swap (swappedFromRoomId set, but
  // no segmented sibling row) can render "swapped from Room X" on the line.
  // Optional — when absent, in-place swaps just omit the tag.
  roomNumberById?: Map<string, string>;
  // reservation_rooms id → ordered from-room numbers of every in-place swap
  // hop on that row (0037 history), e.g. ["101", "102"] for a guest who went
  // 101 → 102 → current. When present, the line shows the FULL chain
  // ("swapped from Room 101 → 102") instead of only the last hop.
  swapHopsByRowId?: Map<string, string[]>;
}

export interface BuiltLineItem {
  description: string;
  sacCode: string;
  quantity: number;
  rate: string;
  amount: string;
  gstRate: string;
  gstAmount: string;
  itemType: "room_charge" | "additional_charge";
}

export interface BuiltInvoice {
  lineItems: BuiltLineItem[];
  subtotal: number;
  totalGst: number;
  cgst: number;
  sgst: number;
  grandTotal: number;
  roomGstRate: number;
}

// "2026-06-01" → "01 Jun"
function formatShortDate(d: string): string {
  const dt = new Date(d);
  const day = String(dt.getDate()).padStart(2, "0");
  const month = dt.toLocaleString("en", { month: "short" });
  return `${day} ${month}`;
}

// A stay-extension delta charge encodes: "we kept the room line at the
// original rate for the added nights, then added this delta on top to
// reach the agreed new rate". On the invoice we'd rather merge that
// back into the room line so the guest sees a clean per-night
// breakdown instead of a confusing delta + base pair.
//
// Parses both description formats:
//   - new: "...— N nights (₹OLD → ₹NEW)..."
//   - legacy: "...— N nights @ ₹NEW/night..."  (oldRate unknown)
interface ExtensionDelta {
  chargeId: string;
  extraNights: number;
  oldRate: number | null;
  newRate: number;
}

function parseExtensionDelta(c: AdditionalCharge): ExtensionDelta | null {
  const desc = c.description ?? "";
  if (!/stay extension/i.test(desc)) return null;
  const nightsMatch = /(\d+)\s*(?:nights?|n)\b/i.exec(desc);
  if (!nightsMatch) return null;
  const extraNights = Number(nightsMatch[1]);
  if (!extraNights) return null;
  const arrow = /₹?(\d[\d,.]*)\s*(?:→|->)\s*₹?(\d[\d,.]*)/.exec(desc);
  const atRate = /@\s*₹?(\d[\d,.]*)\s*\/\s*(?:night|n)\b/i.exec(desc);
  let oldRate: number | null = null;
  let newRate: number;
  if (arrow) {
    oldRate = Number((arrow[1] ?? "").replace(/,/g, ""));
    newRate = Number((arrow[2] ?? "").replace(/,/g, ""));
  } else if (atRate) {
    newRate = Number((atRate[1] ?? "").replace(/,/g, ""));
  } else {
    return null;
  }
  if (!newRate) return null;
  return { chargeId: c.id, extraNights, oldRate, newRate };
}

// Compute the line items + totals for the given scope. GST math
// follows the same exclusive/inclusive rules as the legacy checkout
// path, so per-room invoices produce numbers that sum to the
// combined invoice (give-or-take 1-2 paise rounding per line).
export function buildInvoice(args: BuilderArgs): BuiltInvoice {
  const { reservation, rooms, charges, labelMap, roomNumberById, swapHopsByRowId } = args;
  const isShort = reservation.stayType === "short_stay";
  const shortStayHours = Number(reservation.durationHours ?? 0);
  // For overnight: priced per night. Short-stay: rate IS the per-room
  // flat short-stay price for the chosen duration; 'quantity' becomes
  // the hour count for display only.
  const nights = Math.max(1, Number(reservation.numNights));
  const roomGstRate = Number(reservation.gstRate);
  const gstMode = reservation.gstMode;

  const lineItems: BuiltLineItem[] = [];
  let subtotal = 0;
  let totalGst = 0;

  // Pull stay-extension delta charges out of the charges list. They get
  // MERGED into the room line below (so the breakdown reads naturally
  // — "3n @ ₹1500 + 1n @ ₹2000") instead of printed as a separate
  // delta charge. Only valid when every room shares the same rate
  // (the common case); mixed-rate reservations fall back to printing
  // the delta charge as before.
  const extensionDeltas: ExtensionDelta[] = [];
  const passThroughCharges: AdditionalCharge[] = [];
  const ratesUniform =
    rooms.length > 0 &&
    rooms.every(
      (rr) =>
        Math.abs(Number(rr.ratePerNight) - Number(rooms[0]!.ratePerNight)) < 0.009,
    );
  for (const c of charges) {
    const parsed = !isShort && ratesUniform ? parseExtensionDelta(c) : null;
    if (parsed) extensionDeltas.push(parsed);
    else passThroughCharges.push(c);
  }
  // Per-room split: each room contributes its share of the agreed
  // newRate × extraNights. When oldRate is missing from the legacy
  // description, fall back to the room's stored ratePerNight as the
  // original (which matches what's actually billed today).
  const totalExtraNights = extensionDeltas.reduce(
    (a, d) => a + d.extraNights,
    0,
  );

  // Swap chain index. Rows that share a swap_id are sibling segments
  // of one swap event. Sort them by effective_from so the line
  // description can say "swapped to Room 205" vs "swapped from
  // Room 203" instead of a vague "swap" tag — matches the preview
  // endpoint and the reservation detail page.
  type ChainEntry = {
    rowId: string;
    roomNumber: string;
    effectiveFrom: string;
  };
  const swapChains = new Map<string, ChainEntry[]>();
  for (const rr of rooms) {
    if (!rr.swapId || !rr.id) continue;
    const arr = swapChains.get(rr.swapId) ?? [];
    arr.push({
      rowId: rr.id,
      roomNumber: rr.room.roomNumber,
      effectiveFrom: rr.effectiveFrom ?? reservation.checkInDate,
    });
    swapChains.set(rr.swapId, arr);
  }
  for (const arr of swapChains.values()) {
    arr.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  }
  function swapSibling(
    rowId: string | null,
    swapId: string | null,
  ): { direction: "to" | "from"; roomNumber: string } | null {
    if (!swapId) return null;
    const chain = swapChains.get(swapId);
    if (!chain || chain.length < 2) return null;
    const idx = chain.findIndex((c) => c.rowId === rowId);
    if (idx < 0) return null;
    if (idx === chain.length - 1) {
      return { direction: "from", roomNumber: chain[idx - 1]!.roomNumber };
    }
    return { direction: "to", roomNumber: chain[idx + 1]!.roomNumber };
  }

  // Emit the extra-bed (additional-person) line for a room, if any. Billed
  // at the same GST slab as the room — extra-bed revenue is part of the
  // room tariff. quantity = beds × units; rate = per-bed, per-unit fee.
  // Mutates subtotal/totalGst/lineItems (closures over the loop state).
  function pushExtraBedLine(
    rr: (typeof rooms)[number],
    units: number,
    roomNumber: string,
  ) {
    const beds = Number(rr.extraBeds ?? 0);
    const bedRate = Number(rr.extraBedRate ?? 0);
    if (beds <= 0 || bedRate <= 0 || units <= 0) return;
    const bedQty = beds * units;
    const bedGross = bedRate * bedQty;
    const bedBreak = calcGstBreakdown(bedGross, roomGstRate, gstMode);
    subtotal += bedBreak.subtotal;
    totalGst += bedBreak.gstAmount;
    const unitWord = isShort ? "day" : "night";
    lineItems.push({
      description: `Room ${roomNumber} - Extra bed (${beds} × ${units} ${unitWord}${bedQty === 1 ? "" : "s"})`,
      sacCode: "996311",
      quantity: bedQty,
      rate: String(+(bedBreak.subtotal / bedQty).toFixed(2)),
      amount: String(+bedBreak.subtotal.toFixed(2)),
      gstRate: String(roomGstRate),
      gstAmount: String(+bedBreak.gstAmount.toFixed(2)),
      itemType: "room_charge",
    });
  }

  for (const rr of rooms) {
    const storedRate = Number(rr.ratePerNight);
    const displayType = combinedRoomTypeLabel(
      rr.room.roomType,
      rr.soldAsType ?? null,
      labelMap,
    );
    // Per-row nights for overnight stays. When a row was segmented by a
    // mid-stay swap (0019) it covers a sub-range of the parent stay;
    // count nights between effective_from and effective_to instead of
    // the parent's total. Falls back to the parent stay's nights for
    // unsegmented rows (effective_from/to NULL).
    const rowFrom = rr.effectiveFrom ?? reservation.checkInDate;
    const rowTo = rr.effectiveTo ?? reservation.checkOutDate;
    // Overnight nights via the shared helper (single source of truth for room
    // night counts); short-stay keeps its hours-based display quantity.
    const rowNights = isShort ? nights : roomBillableNights(rr, reservation);

    // Decide whether to split this row into multiple breakdown lines.
    // We only split when:
    //   - overnight
    //   - at least one extension delta merges into this room
    //   - the room actually has enough nights to absorb the extra nights
    const canMergeExtension =
      !isShort && extensionDeltas.length > 0 && rowNights > totalExtraNights;
    const isSegmented = !!(rr.effectiveFrom || rr.effectiveTo);

    if (canMergeExtension) {
      const originalNights = rowNights - totalExtraNights;
      // Original-rate segment.
      const origAmount = storedRate * originalNights;
      const origBreak = calcGstBreakdown(origAmount, roomGstRate, gstMode);
      subtotal += origBreak.subtotal;
      totalGst += origBreak.gstAmount;
      lineItems.push({
        description: `Room ${rr.room.roomNumber} - ${displayType} (${originalNights} night${originalNights === 1 ? "" : "s"} @ ₹${storedRate.toFixed(0)})`,
        sacCode: "996311",
        quantity: originalNights,
        rate: String(+(origBreak.subtotal / originalNights).toFixed(2)),
        amount: String(+origBreak.subtotal.toFixed(2)),
        gstRate: String(roomGstRate),
        gstAmount: String(+origBreak.gstAmount.toFixed(2)),
        itemType: "room_charge",
      });
      // One sub-line per extension delta — preserves multi-extension stays
      // (e.g. extended twice at different rates).
      for (const d of extensionDeltas) {
        const extAmount = d.newRate * d.extraNights;
        const extBreak = calcGstBreakdown(extAmount, roomGstRate, gstMode);
        subtotal += extBreak.subtotal;
        totalGst += extBreak.gstAmount;
        lineItems.push({
          description: `Room ${rr.room.roomNumber} - ${displayType} (${d.extraNights} night${d.extraNights === 1 ? "" : "s"} @ ₹${d.newRate.toFixed(0)} · extension)`,
          sacCode: "996311",
          quantity: d.extraNights,
          rate: String(+(extBreak.subtotal / d.extraNights).toFixed(2)),
          amount: String(+extBreak.subtotal.toFixed(2)),
          gstRate: String(roomGstRate),
          gstAmount: String(+extBreak.gstAmount.toFixed(2)),
          itemType: "room_charge",
        });
      }
      pushExtraBedLine(rr, rowNights, rr.room.roomNumber);
      continue;
    }

    // Default path: single line covering all nights at the stored rate.
    const roomUnits = isShort ? shortStayHours : rowNights;
    const userAmount = isShort ? storedRate : storedRate * rowNights;
    const { subtotal: netRoomSubtotal, gstAmount: roomGst } = calcGstBreakdown(
      userAmount,
      roomGstRate,
      gstMode,
    );
    const netRate = isShort ? netRoomSubtotal : netRoomSubtotal / rowNights;
    subtotal += netRoomSubtotal;
    totalGst += roomGst;
    // A room booked mid-stay via Add Room is segmented (it has its own
    // effective window) but is NOT a swap: no swapId, no swapped-from link, no
    // swap history. Without this, the segmented branch below labels its line
    // "· swapped" — swapSibling returns null for it, so swapTag falls back to
    // the bare "swapped" string, printing a wrong word on a tax invoice.
    const hasSwapHistory = !!(rr.id && (swapHopsByRowId?.get(rr.id)?.length ?? 0) > 0);
    const isAddedRoom =
      isSegmented && !rr.swapId && !rr.swappedFromRoomId && !hasSwapHistory;
    const sibling = swapSibling(rr.id ?? null, rr.swapId ?? null);
    const swapTag = sibling
      ? `swapped ${sibling.direction} Room ${sibling.roomNumber}`
      : "swapped";
    // Swap reason ("Maintenance" etc.) describes what happened to the
    // leaving room, so it belongs only on the closed leg ("swapped
    // to X"). On the new room the reason is misleading — it makes
    // 205 read as if 205 itself were sent to maintenance.
    const reasonSuffix =
      rr.swapReason && sibling?.direction === "to" ? `: ${rr.swapReason}` : "";
    // In-place swap (0036/0037): the row was moved to a new room without
    // segmentation (effective_from/to stay NULL), so `isSegmented` is false
    // and the chain-based swapTag above doesn't fire. Render the FULL path
    // ending at the current room ("swapped Room 101 → 102 → 103") from the
    // 0037 history; fall back to the single swappedFromRoomId hop when no
    // history map was passed.
    const hopChain = !isSegmented && rr.id ? swapHopsByRowId?.get(rr.id) : undefined;
    const fromRooms =
      hopChain && hopChain.length > 0
        ? hopChain
        : !isSegmented && rr.swappedFromRoomId
          ? (() => {
              const n = roomNumberById?.get(rr.swappedFromRoomId!);
              return n ? [n] : [];
            })()
          : [];
    const inPlaceSwapPath =
      fromRooms.length > 0 ? [...fromRooms, rr.room.roomNumber].join(" → ") : null;
    const overnightSuffix = isAddedRoom
      ? `(${rowNights} night${rowNights === 1 ? "" : "s"}, ${formatShortDate(rowFrom)} → ${formatShortDate(rowTo)} · added mid-stay)`
      : isSegmented
        ? `(${rowNights} night${rowNights === 1 ? "" : "s"}, ${formatShortDate(rowFrom)} → ${formatShortDate(rowTo)} · ${swapTag}${reasonSuffix})`
        : inPlaceSwapPath
          ? `(${rowNights} night${rowNights === 1 ? "" : "s"} · swapped Room ${inPlaceSwapPath})`
          : `(${rowNights} nights)`;
    lineItems.push({
      description: isShort
        ? `Room ${rr.room.roomNumber} - ${displayType} (Day use · ${shortStayHours} hours)`
        : `Room ${rr.room.roomNumber} - ${displayType} ${overnightSuffix}`,
      sacCode: "996311",
      quantity: roomUnits,
      rate: String(+netRate.toFixed(2)),
      amount: String(+netRoomSubtotal.toFixed(2)),
      gstRate: String(roomGstRate),
      gstAmount: String(+roomGst.toFixed(2)),
      itemType: "room_charge",
    });
    // NOT roomUnits. For a day-use booking roomUnits is the HOUR count (it
    // drives the room line's "6 hours" quantity), but the room itself is
    // billed flat at storedRate — so passing it here multiplied the extra bed
    // by the hours: a 6-hour stay with one ₹500 bed invoiced ₹3,000 as
    // "Extra bed (1 × 6 days)". The combined-checkout path already bills that
    // same bed once; this is the default per-room path, so the two disagreed
    // 6× on identical data. An extra bed is one flat charge per night, and a
    // day-use stay is one occasion.
    pushExtraBedLine(rr, isShort ? 1 : rowNights, rr.room.roomNumber);
  }

  // Decide whether the extension deltas were actually merged. They are
  // merged ONLY if at least one room split into the extension breakdown
  // above. Otherwise (e.g. a single 1-night reservation where the room
  // can't absorb the extra night, or mixed rates) they stay as
  // pass-through charges so the invoice math still adds up.
  const anyRoomCouldMerge = rooms.some((rr) => {
    const rowNights = roomBillableNights(rr, reservation);
    return !isShort && extensionDeltas.length > 0 && rowNights > totalExtraNights;
  });
  const chargesToPrint = anyRoomCouldMerge
    ? passThroughCharges
    : [...passThroughCharges, ...extensionDeltas.map((d) => charges.find((c) => c.id === d.chargeId)!).filter(Boolean)];

  for (const c of chargesToPrint) {
    const amount = Number(c.amount);
    const gstRate = Number(c.gstRate);
    const gstAmount = +(amount * (gstRate / 100)).toFixed(2);
    subtotal += amount;
    totalGst += gstAmount;
    lineItems.push({
      description: c.description,
      sacCode: "9963",
      quantity: c.quantity,
      rate: String(c.rate),
      amount: String(+amount.toFixed(2)),
      gstRate: String(gstRate),
      gstAmount: String(gstAmount),
      itemType: "additional_charge",
    });
  }

  subtotal = +subtotal.toFixed(2);
  totalGst = +totalGst.toFixed(2);
  const cgst = +(totalGst / 2).toFixed(2);
  const sgst = +(totalGst - cgst).toFixed(2);
  const grandTotal = +(subtotal + totalGst).toFixed(2);

  return { lineItems, subtotal, totalGst, cgst, sgst, grandTotal, roomGstRate };
}

// Pick which charges belong on a per-room invoice. Rules:
//   - charges with room_id IN the scope rooms → always included
//   - charges with room_id NOT NULL but NOT in scope → excluded
//   - charges with room_id NULL ("reservation-wide") → included only
//     when this invoice covers the LAST remaining un-invoiced rooms.
//     This guarantees they don't disappear, and don't get
//     double-counted.
export function selectChargesForScope(args: {
  allCharges: AdditionalCharge[];
  scopeRoomIds: string[];
  // Rooms that still have no invoice. If this invoice covers ALL of
  // them, attach the orphan (room-NULL) charges here.
  remainingUnInvoicedRoomIds: string[];
}): AdditionalCharge[] {
  const scopeSet = new Set(args.scopeRoomIds);
  const remainingSet = new Set(args.remainingUnInvoicedRoomIds);
  const coversAllRemaining =
    args.scopeRoomIds.length > 0 &&
    args.scopeRoomIds.every((id) => remainingSet.has(id)) &&
    args.remainingUnInvoicedRoomIds.every((id) => scopeSet.has(id));
  return args.allCharges.filter((c) => {
    if (c.roomId == null) return coversAllRemaining;
    return scopeSet.has(c.roomId);
  });
}

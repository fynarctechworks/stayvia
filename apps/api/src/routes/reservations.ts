import {
  addRoomSchema,
  additionalChargeSchema,
  cancelSchema,
  convertInvoicesSchema,
  noShowSchema,
  makeComplimentarySchema,
  checkInSchema,
  checkOutSchema,
  editChargeSchema,
  editDatesSchema,
  editRoomRateSchema,
  extendContinueSchema,
  extendOptionsQuerySchema,
  extendReservationSchema,
  extendSplitSchema,
  lateCheckoutSchema,
  reservationCreateSchema,
  reservationListQuerySchema,
  swapRoomSchema,
  swapRoomSegmentSchema,
} from "@stayvia/shared";
import { randomUUID } from "node:crypto";
import { differenceInCalendarDays, format } from "date-fns";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { additionalCharges, invoiceLineItems, invoices, payments } from "../db/schema/invoices.js";
import { reservationCoGuests, reservationRoomSwapHistory, reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { roomTypes } from "../db/schema/settings.js";
import { maintenanceIssues } from "../db/schema/maintenance.js";
import { combinedRoomTypeLabel, type RoomTypeLabelMap } from "../lib/roomTypeLabel.js";
import { logActivity } from "../lib/activity.js";
import { logger } from "../lib/logger.js";
import { propertyToday } from "../lib/propertyTime.js";
import {
  findAvailableRooms,
  findRoomConflicts,
  isRoomAvailable,
  lockKey,
  lockRoom,
  nextCreditNoteSequence,
  nextDailySequence,
  nextInvoiceSequence,
  type RoomConflict,
} from "../lib/availability.js";
import { getGuestBalance } from "../lib/ledger.js";
import {
  attachOrphanPaymentsAndRecompute,
  recomputeInvoiceTotals,
  recomputeReservationBalance,
} from "../lib/reservationBalance.js";
import { resolveCurrentPropertyId } from "../lib/currentProperty.js";
import { calcGstBreakdown, getGstRate } from "../lib/gst.js";
import { loadGuestExtra } from "../lib/guestExtra.js";
import { buildInvoice, selectChargesForScope } from "../lib/invoiceBuilder.js";
import { PAYMENT_METHODS } from "../db/schema/enums.js";
import { creditNoteNumber, invoiceNumber, reservationNumber } from "../lib/numbers.js";
import { hashOtp } from "../lib/otp.js";
import { renderInvoicePdf, renderReceiptPdf } from "../lib/pdf.js";
import { generateReceiptNumber } from "../lib/receipt.js";
import { documentLabel, signedKycUrl, uploadPublicPdf } from "../lib/storage.js";
import { dispatchNotification, notifyGuestSms, notifyOwner } from "../lib/notify.js";
import { renderTemplate } from "../lib/templates.js";
import { env } from "../config/env.js";
import { invalidateDashboard } from "../lib/redis.js";
import { fail, list, ok } from "../lib/response.js";
import { getSettings } from "../lib/settings.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { resolveReservationId } from "../middleware/resolveReservation.js";
import { idempotent } from "../middleware/idempotency.js";
import { validate } from "../middleware/validate.js";
import { guests } from "../db/schema/guests.js";
import { otps } from "../db/schema/otps.js";
import { guestLedger } from "../db/schema/guestLedger.js";
import { notifications } from "../db/schema/notifications.js";

const router = Router();

// Build a room-id → room-number map for buildInvoice(), so in-place swaps
// can render "swapped from Room X" on the bill. Seeds from the reservation's
// own room rows, then resolves any swapped-from room IDs not already present
// (the previous room is gone from the row set after an in-place swap).
async function buildRoomNumberMap(
  resRoomRows: { room: { id: string; roomNumber: string }; rr: { swappedFromRoomId: string | null } }[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const x of resRoomRows) map.set(x.room.id, x.room.roomNumber);
  const missing = resRoomRows
    .map((x) => x.rr.swappedFromRoomId)
    .filter((id): id is string => !!id && !map.has(id));
  if (missing.length > 0) {
    const extra = await db
      .select({ id: rooms.id, roomNumber: rooms.roomNumber })
      .from(rooms)
      .where(inArray(rooms.id, Array.from(new Set(missing))));
    for (const r of extra) map.set(r.id, r.roomNumber);
  }
  return map;
}

// reservation_rooms id → ordered from-room numbers of its in-place swap hops
// (0037 history), e.g. ["101", "102"] for 101 → 102 → current. Feeds
// buildInvoice's swapHopsByRowId so the bill shows the full move chain.
async function buildSwapHopsMap(rowIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (rowIds.length === 0) return map;
  const hops = await db
    .select({
      rrId: reservationRoomSwapHistory.reservationRoomId,
      fromNumber: rooms.roomNumber,
    })
    .from(reservationRoomSwapHistory)
    .innerJoin(rooms, eq(rooms.id, reservationRoomSwapHistory.fromRoomId))
    .where(inArray(reservationRoomSwapHistory.reservationRoomId, rowIds))
    .orderBy(reservationRoomSwapHistory.createdAt);
  for (const h of hops) {
    const list = map.get(h.rrId) ?? [];
    list.push(h.fromNumber);
    map.set(h.rrId, list);
  }
  return map;
}

// Resolve `:id` to a UUID before every handler — lets clients use
// either the UUID or the human-readable SLDT-RES-NNNN format
// interchangeably. Handlers downstream keep using req.params.id and
// always see a UUID. Cached in-memory; cheap.
router.param("id", resolveReservationId as never);

// Loads slug → label for every room type (active + archived). Used by the
// invoice/receipt rendering paths so the displayed room-type names match
// what staff typed in Settings → Room Types, including correct casing for
// types like "Non AC Single Bed Rooms" where the slug doesn't title-case.
async function buildRoomTypeLabelMap(): Promise<RoomTypeLabelMap> {
  const rows = await db.select({ slug: roomTypes.slug, label: roomTypes.label }).from(roomTypes);
  return new Map(rows.map((r) => [r.slug, r.label]));
}

router.get(
  "/",
  requireAuth,
  requirePermission("view_reservations"),
  validate(reservationListQuerySchema, "query"),
  async (req, res) => {
    const {
      status,
      date,
      q,
      date_from,
      date_to,
      room_id,
      floor,
      include_complimentary,
      page,
      per_page,
    } = req.query as unknown as {
      status?: string;
      date?: string;
      q?: string;
      date_from?: string;
      date_to?: string;
      room_id?: string;
      floor?: number;
      include_complimentary?: boolean;
      page: number;
      per_page: number;
    };
    const conditions = [];
    if (status) conditions.push(eq(reservations.status, status as never));
    if (date) {
      conditions.push(lte(reservations.checkInDate, date));
      conditions.push(gte(reservations.checkOutDate, date));
    }
    if (date_from) conditions.push(gte(reservations.checkInDate, date_from));
    if (date_to) conditions.push(lte(reservations.checkInDate, date_to));
    if (q) {
      const like = `%${q}%`;
      conditions.push(
        sql`(${reservations.reservationNumber} ILIKE ${like} OR ${guests.fullName} ILIKE ${like} OR ${guests.phone} ILIKE ${like})`,
      );
    }
    // Room / floor filters. EXISTS subqueries against reservation_rooms +
    // rooms so multi-room reservations match when ANY of their rooms
    // satisfies the filter. We don't add a JOIN to the main query
    // because that would force DISTINCT on every other path.
    if (room_id) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${reservationRooms} rr
          WHERE rr.reservation_id = ${reservations.id}
            AND rr.room_id = ${room_id}::uuid
        )`,
      );
    }
    if (floor !== undefined) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${reservationRooms} rr
          JOIN ${rooms} rm ON rm.id = rr.room_id
          WHERE rr.reservation_id = ${reservations.id}
            AND rm.floor = ${floor}
        )`,
      );
    }
    // Hide complimentary bookings from the main list by default — they
    // live in Reports → Complimentary. The override flag is for admin
    // tooling that needs to surface every reservation.
    if (!include_complimentary) {
      conditions.push(sql`${reservations.bookingSource} <> 'complimentary'`);
    }

    const [rows, total] = await Promise.all([
      db
        .select({
          reservation: reservations,
          guestName: guests.fullName,
          guestPhone: guests.phone,
          // Storage key for the guest's customer photo (uploaded during KYC).
          // Signed per-row below so the card can render <img>. Null when the
          // guest hasn't been photographed yet — the card then shows initials.
          guestPhotoKey: guests.guestPhoto,
          // Comma-separated room numbers so the list card can show the
          // allotted rooms without a second fetch per row. Subquery groups
          // by reservation id and orders numerically.
          roomNumbers: sql<string>`COALESCE((
            SELECT string_agg(${rooms.roomNumber}, ',' ORDER BY ${rooms.roomNumber})
            FROM ${reservationRooms}
            JOIN ${rooms} ON ${rooms.id} = ${reservationRooms.roomId}
            WHERE ${reservationRooms.reservationId} = ${reservations.id}
          ), '')`,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(reservations.createdAt))
        .limit(per_page)
        .offset((page - 1) * per_page),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(conditions.length ? and(...conditions) : undefined),
    ]);

    // Sign all storage keys in parallel. Null keys produce null URLs.
    const photoUrls = await Promise.all(
      rows.map((r) => (r.guestPhotoKey ? signedKycUrl(r.guestPhotoKey) : Promise.resolve(null))),
    );

    return list(
      res,
      rows.map((r, i) => ({
        ...r.reservation,
        guestName: r.guestName,
        guestPhone: r.guestPhone,
        guestPhotoUrl: photoUrls[i] ?? null,
        roomNumbers: r.roomNumbers,
      })),
      { total: total[0]?.count ?? 0, page, per_page },
    );
  },
);

router.get("/:id", requireAuth, requirePermission("view_reservations"), async (req, res) => {
  const id = req.params.id!;
  const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
  if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");

  const [resRooms, charges, guest] = await Promise.all([
    db
      .select({ rr: reservationRooms, room: rooms })
      .from(reservationRooms)
      .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
      .where(eq(reservationRooms.reservationId, id)),
    db
      .select()
      .from(additionalCharges)
      .where(eq(additionalCharges.reservationId, id))
      .orderBy(asc(additionalCharges.createdAt)),
    db.select().from(guests).where(eq(guests.id, r[0]!.guestId)).limit(1),
  ]);

  // Resolve the in-place swap history for each row. 0036 stored only
  // the immediately-prior room — fine for a single swap, but a chain
  // (202 -> 201 -> 301) collapsed to "from 201". 0037 added a per-row
  // history table; here we fetch the chain and resolve every hop's
  // room metadata so the UI can render a closed-leg ladder above the
  // active row.
  type RoomMeta = {
    id: string;
    roomNumber: string;
    roomType: string;
    hasAc: boolean;
    hasTv: boolean;
    hasWifi: boolean;
  };
  const rrIds = resRooms.map((x) => x.rr.id);
  const histories = rrIds.length
    ? await db
        .select()
        .from(reservationRoomSwapHistory)
        .where(inArray(reservationRoomSwapHistory.reservationRoomId, rrIds))
        .orderBy(reservationRoomSwapHistory.createdAt)
    : [];
  // Every room id referenced anywhere in the chain (origin + intermediate
  // hops), so we can look up metadata in a single query.
  const historyRoomIds = new Set<string>();
  for (const h of histories) {
    historyRoomIds.add(h.fromRoomId);
    historyRoomIds.add(h.toRoomId);
  }
  for (const x of resRooms) {
    if (x.rr.swappedFromRoomId) historyRoomIds.add(x.rr.swappedFromRoomId);
  }
  const roomMetaMap = new Map<string, RoomMeta>();
  if (historyRoomIds.size > 0) {
    const fromRows = await db
      .select({
        id: rooms.id,
        roomNumber: rooms.roomNumber,
        roomType: rooms.roomType,
        hasAc: rooms.hasAc,
        hasTv: rooms.hasTv,
        hasWifi: rooms.hasWifi,
      })
      .from(rooms)
      .where(inArray(rooms.id, Array.from(historyRoomIds)));
    for (const fr of fromRows) roomMetaMap.set(fr.id, fr);
  }
  // Group history hops by reservation_room id so each row can attach
  // its own ladder.
  const historyByRR = new Map<string, typeof histories>();
  for (const h of histories) {
    const arr = historyByRR.get(h.reservationRoomId) ?? [];
    arr.push(h);
    historyByRR.set(h.reservationRoomId, arr);
  }

  // Pull ALL invoices for this reservation. Per-room (0017) means a
  // multi-room booking may have several invoices — one per room plus
  // an optional combined one. `invoice` (singular) stays for back-compat;
  // `invoices` (plural) is the full list with scope tags.
  const allInvoices = await db
    .select()
    .from(invoices)
    .where(eq(invoices.reservationId, id))
    .orderBy(asc(invoices.createdAt));
  const inv = allInvoices[0] ?? null;
  const pays = await db
    .select()
    .from(payments)
    .where(eq(payments.reservationId, id))
    .orderBy(desc(payments.paymentDate));

  // Wallet-credit activity tied to this reservation. The cancel-as-
  // credit flow inserts a credit_issued row here; without surfacing
  // it on the reservation page, staff cancelling for "credit" sees
  // no trace of where the advance went. Filtered to rows that name
  // THIS reservation, ordered newest-first so it merges cleanly with
  // the payments list in the UI.
  const walletLedger = await db
    .select()
    .from(guestLedger)
    .where(eq(guestLedger.reservationId, id))
    .orderBy(desc(guestLedger.createdAt));

  // Per-room occupants. We need each room's guest for the UI, but the
  // guest_id on reservation_rooms doesn't carry the row — fetch them
  // in one batch by distinct id.
  const occupantIds = Array.from(new Set(resRooms.map((x) => x.rr.guestId))).filter(Boolean);
  const occupants = occupantIds.length
    ? await db
        .select({
          id: guests.id,
          fullName: guests.fullName,
          phone: guests.phone,
          guestPhoto: guests.guestPhoto,
        })
        .from(guests)
        .where(inArray(guests.id, occupantIds))
    : [];

  // Same-day re-let watch: for a FUTURE confirmed booking, list any
  // currently-checked-in walk-in occupying any of this reservation's
  // rooms and due to vacate by THIS reservation's check-in date. The
  // UI surfaces these as "Re-let pending" badges so the desk knows
  // the room is in use right now and the walk-in needs to be checked
  // out before this guest arrives.
  const myRoomIds = resRooms.map((x) => x.room.id);
  const reletWatch =
    r[0]!.status === "confirmed" && myRoomIds.length > 0
      ? await db
          .select({
            roomId: reservationRooms.roomId,
            reservationId: reservations.id,
            reservationNumber: reservations.reservationNumber,
            guestName: guests.fullName,
            checkOutDate: reservations.checkOutDate,
          })
          .from(reservationRooms)
          .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
          .innerJoin(guests, eq(guests.id, reservations.guestId))
          .where(
            and(
              inArray(reservationRooms.roomId, myRoomIds),
              eq(reservations.status, "checked_in"),
              lte(reservations.checkOutDate, r[0]!.checkInDate),
              ne(reservations.id, id),
            ),
          )
      : [];
  const reletByRoom = new Map<string, (typeof reletWatch)[number]>();
  for (const w of reletWatch) {
    if (!reletByRoom.has(w.roomId)) reletByRoom.set(w.roomId, w);
  }
  const occupantById = new Map(occupants.map((g) => [g.id, g]));

  // Migration 0020 — co-guests linked to this reservation. Join with
  // guests so the UI can render name/phone/gender without a follow-up
  // fetch.
  const coGuestRows = await db
    .select({
      cg: reservationCoGuests,
      g: {
        id: guests.id,
        fullName: guests.fullName,
        phone: guests.phone,
        gender: guests.gender,
        idProofType: guests.idProofType,
        idProofLast4: guests.idProofLast4,
        guestPhoto: guests.guestPhoto,
      },
    })
    .from(reservationCoGuests)
    .innerJoin(guests, eq(guests.id, reservationCoGuests.guestId))
    .where(eq(reservationCoGuests.reservationId, id))
    .orderBy(asc(reservationCoGuests.position));

  const s = await getSettings();

  const guestPhotoUrl = guest[0]?.guestPhoto ? await signedKycUrl(guest[0].guestPhoto) : null;

  return ok(res, {
    ...r[0],
    guest: guest[0] ? { ...guest[0], photoUrl: guestPhotoUrl } : guest[0],
    rooms: await (async () => {
      const m = await buildRoomTypeLabelMap();
      return resRooms.map((x) => {
        const occ = occupantById.get(x.rr.guestId);
        return {
          ...x.room,
          // Per-row state from reservation_rooms (0017).
          reservationRoomId: x.rr.id,
          ratePerNight: x.rr.ratePerNight,
          soldAsType: x.rr.soldAsType,
          // Extra beds (additional persons) booked on this room (0043).
          extraBeds: x.rr.extraBeds,
          extraBedRate: x.rr.extraBedRate,
          roomStatus: x.rr.status,
          roomCheckedInAt: x.rr.checkedInAt,
          roomCheckedOutAt: x.rr.checkedOutAt,
          roomInvoiceId: x.rr.invoiceId,
          // Per-row segment columns (0019 mid-stay swap). NULL on either
          // bound means the row covers the entire parent stay (legacy
          // / unsegmented). swapId links sibling segments.
          effectiveFrom: x.rr.effectiveFrom,
          effectiveTo: x.rr.effectiveTo,
          swapId: x.rr.swapId,
          swapReason: x.rr.swapReason,
          // 0037 — every in-place swap hop on this row, ordered
          // oldest-first. The UI renders one virtual "closed leg" row
          // per entry above the active row, so a 202 -> 201 -> 301
          // chain reads as three rows: [202 closed -> 201], [201
          // closed -> 301], [301 active]. `swappedFromRoom` stays for
          // backwards-compat callers (Room PDFs etc.) and mirrors the
          // most recent hop.
          swapHistory: (historyByRR.get(x.rr.id) ?? []).map((h) => {
            const fromR = roomMetaMap.get(h.fromRoomId);
            const toR = roomMetaMap.get(h.toRoomId);
            return {
              id: h.id,
              fromRoom: fromR
                ? {
                    id: fromR.id,
                    roomNumber: fromR.roomNumber,
                    roomType: fromR.roomType,
                    displayType: combinedRoomTypeLabel(fromR.roomType, x.rr.soldAsType, m),
                    hasAc: fromR.hasAc,
                    hasTv: fromR.hasTv,
                    hasWifi: fromR.hasWifi,
                  }
                : null,
              toRoomNumber: toR?.roomNumber ?? null,
              reason: h.reason,
              ratePerNight: h.ratePerNight,
              createdAt: h.createdAt,
            };
          }),
          swappedFromRoom: (() => {
            if (!x.rr.swappedFromRoomId) return null;
            const src = roomMetaMap.get(x.rr.swappedFromRoomId);
            if (!src) return null;
            return {
              id: src.id,
              roomNumber: src.roomNumber,
              roomType: src.roomType,
              displayType: combinedRoomTypeLabel(src.roomType, x.rr.soldAsType, m),
              hasAc: src.hasAc,
              hasTv: src.hasTv,
              hasWifi: src.hasWifi,
            };
          })(),
          occupant: occ
            ? {
                id: occ.id,
                fullName: occ.fullName,
                phone: occ.phone,
                isBooker: occ.id === r[0]!.guestId,
              }
            : null,
          // Pre-rendered display label for the receipt + reservation detail:
          // "Ac Single Bed Rooms" or "Ac Single Bed Rooms booked as Non Ac
          // Bed Rooms" — see lib/roomTypeLabel.ts.
          displayType: combinedRoomTypeLabel(x.room.roomType, x.rr.soldAsType, m),
          // Same-day re-let watch. When this future reservation's room
          // is currently held by a checked-in walk-in due to vacate
          // before our check-in date, surface a small banner.
          reletPending: reletByRoom.get(x.room.id) ?? null,
        };
      });
    })(),
    coGuests: coGuestRows.map((row) => ({
      id: row.cg.id,
      position: row.cg.position,
      guest: row.g,
    })),
    additionalCharges: charges,
    invoice: inv,
    invoices: allInvoices,
    payments: pays,
    walletLedger,
    hotelCheckInTime: s.checkInTime,
    hotelCheckOutTime: s.checkOutTime,
  });
});

router.post(
  "/",
  requireAuth,
  requirePermission("view_reservations"),
  idempotent("reservations.create"),
  validate(reservationCreateSchema),
  async (req, res) => {
    const input = req.body as import("@stayvia/shared").ReservationCreateInput;

    // Verify the OTP up-front. We intentionally do this BEFORE any
    // availability / pricing / lock work so a bad/missing OTP wastes no
    // DB time. The matching OTP row is selected for consumption later
    // inside the create transaction so a verified code can't be replayed
    // across two requests.
    let otpRowIdToConsume: string | null = null;
    if (input.otpCode) {
      // Match by guestId (existing-guest OTP) OR by the guest's phone with
      // both anchors empty (phone-anchored OTP sent before the guest row
      // existed — the deferred-guest walk-in flow).
      const [otpGuest] = await db
        .select({ phone: guests.phone })
        .from(guests)
        .where(eq(guests.id, input.guestId))
        .limit(1);
      const [otpRow] = await db
        .select()
        .from(otps)
        .where(
          and(
            or(
              eq(otps.guestId, input.guestId),
              and(eq(otps.target, otpGuest?.phone ?? ""), isNull(otps.guestId)),
            ),
            isNull(otps.reservationId),
            isNull(otps.consumedAt),
            eq(otps.purpose, "checkin"),
          ),
        )
        .orderBy(desc(otps.createdAt))
        .limit(1);
      if (!otpRow) {
        return fail(res, 400, "OTP_REQUIRED", "OTP verification required before booking");
      }
      if (otpRow.expiresAt < new Date()) {
        return fail(res, 400, "OTP_EXPIRED", "OTP expired. Request a new code.");
      }
      if (otpRow.codeHash !== hashOtp(input.otpCode)) {
        return fail(res, 400, "OTP_INVALID", "Incorrect OTP code");
      }
      otpRowIdToConsume = otpRow.id;
    } else {
      // No OTP code. Allow the create ONLY when the property has OTP turned
      // off. We read the setting server-side rather than trusting the
      // client's skipOtp flag, so a caller can't skip OTP the operator
      // required just by sending skipOtp:true.
      const { otpRequiredForCheckin } = await getSettings();
      if (otpRequiredForCheckin) {
        return fail(res, 400, "OTP_REQUIRED", "OTP verification required before booking");
      }
    }

    // Blacklist guard. Reject before any availability / pricing work
    // so a blacklisted guest can't even probe inventory. Returns 403
    // with the audit reason so the desk staff knows what to tell them.
    const [guestRow] = await db
      .select({
        isBlacklisted: guests.isBlacklisted,
        blacklistReason: guests.blacklistReason,
      })
      .from(guests)
      .where(eq(guests.id, input.guestId))
      .limit(1);
    if (!guestRow) {
      return fail(res, 404, "GUEST_NOT_FOUND", "Guest not found");
    }
    if (guestRow.isBlacklisted) {
      return fail(
        res,
        403,
        "GUEST_BLACKLISTED",
        `This guest is blacklisted${guestRow.blacklistReason ? ` (${guestRow.blacklistReason})` : ""}. An admin must clear the blacklist before booking.`,
      );
    }

    const roomIds = input.rooms.map((r) => r.roomId);

    // Phase 2: every new reservation + its payments are scoped to the
    // current property. Resolved once and threaded through the tx.
    const propertyId = await resolveCurrentPropertyId(req);

    const settings = await getSettings();
    const stayType = input.stayType ?? "overnight";
    const isShortStay = stayType === "short_stay";

    // Date / duration sanity. For overnight: nights >= 1, priced per-night
    // per-room. For short_stay: same-day, durationHours required, each
    // room's ratePerNight is interpreted as the FLAT short-stay price for
    // the requested duration (client derives this from the room type's
    // bands, or pro-rates a custom-hours entry).
    let nights = 0;
    let durationHours = 0;
    if (isShortStay) {
      if (input.checkInDate !== input.checkOutDate) {
        return fail(
          res,
          400,
          "INVALID_DATES",
          "Short-stay bookings must check-in and check-out on the same date",
        );
      }
      if (!input.durationHours || input.durationHours <= 0) {
        return fail(res, 400, "INVALID_DURATION", "Short-stay bookings require a positive duration");
      }
      durationHours = +input.durationHours;
    } else {
      nights = differenceInCalendarDays(
        new Date(input.checkOutDate),
        new Date(input.checkInDate),
      );
      if (nights < 1) {
        return fail(res, 400, "INVALID_DATES", "Check-out must be at least 1 day after check-in");
      }
    }

    // The user-typed rate is the grand-total amount per room when the
    // property is in 'inclusive' mode (GST already baked in) and the net
    // amount per room when in 'exclusive' mode (GST added on top).
    // We compute a single `roomAmount` that represents the user's input,
    // then derive both the stored subtotal (net) and the grand total
    // through calcGstBreakdown which handles both modes.
    //
    // Extra beds (additional persons over a room's capacity) carry a
    // per-night, per-person fee. We keep the BASE room amount separate so
    // the GST slab is decided purely from the room rate (extra-bed money
    // must not push a room into a higher slab), then add the extra-bed
    // amount into the taxable roomAmount at that same slab — extra-bed
    // revenue is part of the room tariff.
    const billingUnits = isShortStay ? 1 : nights;
    const roomBaseAmount = +input.rooms
      .reduce((a, r) => a + r.ratePerNight * billingUnits, 0)
      .toFixed(2);
    const extraBedAmount = +input.rooms
      .reduce(
        (a, r) => a + (r.extraBeds ?? 0) * (r.extraBedRate ?? 0) * billingUnits,
        0,
      )
      .toFixed(2);
    const roomAmount = +(roomBaseAmount + extraBedAmount).toFixed(2);
    const avgRate = isShortStay
      ? roomBaseAmount / input.rooms.length
      : roomBaseAmount / (nights * input.rooms.length);
    const gstRate = getGstRate(avgRate, {
      exemptBelow: Number(settings.gstSlabExemptBelow),
      lowRate: Number(settings.gstSlabLowRate),
      lowMax: Number(settings.gstSlabLowMax),
      highRate: Number(settings.gstSlabHighRate),
    });
    const gstMode = settings.gstMode ?? "exclusive";
    const { subtotal, gstAmount, grandTotal } = calcGstBreakdown(roomAmount, gstRate, gstMode);

    // Hard guard: advance can never exceed the bill. Over-collecting at
    // booking would create a negative balance_due and silently turn the
    // surplus into a phantom wallet credit, which is exactly the kind of
    // accounting hole this PMS shouldn't allow. Staff should record the
    // exact amount, then add a real wallet-credit entry separately if the
    // guest is pre-paying for a future stay.
    if (input.advancePaid > grandTotal + 0.009) {
      return fail(
        res,
        400,
        "ADVANCE_TOO_HIGH",
        `Advance ₹${input.advancePaid.toFixed(2)} exceeds grand total ₹${grandTotal.toFixed(2)}`,
      );
    }

    // Wrap everything in a single tx. Take per-room advisory locks first so
    // concurrent reservation creates for the same room serialize cleanly, then
    // re-check availability inside the locked window before inserting. The
    // sequence allocator also runs inside the tx with its own advisory lock,
    // so unique reservation_number collisions are impossible.
    let unavailableRoom: string | null = null;
    let created: typeof reservations.$inferSelect | null = null;
    let walletApplied = 0;
    type InsufficientInfo = { requested: number; available: number };
    const insufficientRef: { value: InsufficientInfo | null } = { value: null };
    try {
      created = await db.transaction(async (tx) => {
        // Deterministic lock order to avoid deadlocks between concurrent creates.
        const sorted = [...roomIds].sort();
        for (const rid of sorted) {
          await lockRoom(tx, rid);
        }

        // For short_stay (checkInDate === checkOutDate), [d, d) collapses
        // to an empty Postgres range and the daterange overlap silently
        // passes. Widen the probe to [d, d+1) so the lib's short_stay
        // branch fires — without this, two concurrent same-day day-use
        // creates for the same room both pass this check and race-insert.
        const isShortStay = input.stayType === "short_stay";
        const probeOut = isShortStay
          ? new Date(new Date(input.checkInDate).getTime() + 86400000)
              .toISOString()
              .slice(0, 10)
          : input.checkOutDate;
        for (const roomId of roomIds) {
          const ok = await isRoomAvailable(
            roomId,
            input.checkInDate,
            probeOut,
            undefined,
            tx,
          );
          if (!ok) {
            unavailableRoom = roomId;
            throw new Error("ROOM_UNAVAILABLE");
          }
        }

        // Wallet credit handling: cap requested amount at both (a) the
        // grandTotal (no over-applying) and (b) the guest's current balance.
        // Take a guest-scoped advisory lock so two concurrent applies can't
        // both pass the balance check and over-spend.
        const requestedCredit = +(input.useWalletCredit ?? 0).toFixed(2);
        if (requestedCredit > 0) {
          await lockKey(tx, `guest-wallet:${input.guestId}`);
          const balance = await getGuestBalance(input.guestId, tx);
          const cappedToBill = Math.min(requestedCredit, grandTotal);
          if (cappedToBill > balance + 0.009) {
            insufficientRef.value = { requested: cappedToBill, available: balance };
            throw new Error("INSUFFICIENT_WALLET_BALANCE");
          }
          walletApplied = +cappedToBill.toFixed(2);
        }

        const balanceDue = +(grandTotal - input.advancePaid - walletApplied).toFixed(2);

        const seq = await nextDailySequence(`SLDT-RES-%`, tx);
        const resNumber = reservationNumber(seq);

        // For short_stay, fold the chosen band label (e.g. "Day use · 6 hours")
        // into specialRequests so it surfaces on the reservation detail, the
        // receipt, and the invoice without needing another column.
        const composedSpecial = (() => {
          const parts: string[] = [];
          if (isShortStay) {
            const label = input.shortStayLabel?.trim();
            parts.push(label && label.length > 0 ? label : `Day use · ${durationHours} hours`);
          }
          const extra = input.specialRequests?.trim();
          if (extra) parts.push(extra);
          return parts.length ? parts.join(" — ") : null;
        })();

        const [r] = await tx
          .insert(reservations)
          .values({
            reservationNumber: resNumber,
            propertyId,
            guestId: input.guestId,
            checkInDate: input.checkInDate,
            checkOutDate: input.checkOutDate,
            stayType,
            durationHours: isShortStay ? String(durationHours.toFixed(2)) : null,
            numAdults: input.numAdults,
            numChildren: input.numChildren,
            ratePerNight: String(avgRate.toFixed(2)),
            subtotal: String(subtotal),
            gstRate: String(gstRate),
            gstAmount: String(gstAmount),
            grandTotal: String(grandTotal),
            // Snapshot the property's GST mode at create time. Recalcs
            // honour this so a later settings flip doesn't rewrite math
            // on existing bookings.
            gstMode,
            advancePaid: String(input.advancePaid),
            walletCreditApplied: String(walletApplied.toFixed(2)),
            balanceDue: String(balanceDue),
            status: "confirmed",
            bookingSource: input.bookingSource ?? "walkin",
            creditNotes: input.creditNotes ?? null,
            specialRequests: composedSpecial,
            // 0023 — staff-chosen arrival/departure clock times.
            // Stored only when the caller supplied them; UI falls
            // back to property policy when these are NULL.
            plannedCheckInAt: input.plannedCheckInAt
              ? new Date(input.plannedCheckInAt)
              : null,
            plannedCheckOutAt: input.plannedCheckOutAt
              ? new Date(input.plannedCheckOutAt)
              : null,
            createdBy: req.user!.id,
          })
          .returning();

        // Record the credit_used ledger entry inside the same tx so it
        // commits atomically with the reservation.
        if (walletApplied > 0) {
          await tx.insert(guestLedger).values({
            guestId: input.guestId,
            entryType: "credit_used",
            amount: String(walletApplied.toFixed(2)),
            reservationId: r!.id,
            note: `Applied to booking ${r!.reservationNumber}`,
            createdBy: req.user!.id,
          });
        }

        await tx.insert(reservationRooms).values(
          input.rooms.map((rm) => ({
            reservationId: r!.id,
            roomId: rm.roomId,
            ratePerNight: String(rm.ratePerNight),
            soldAsType: rm.soldAsType ?? null,
            extraBeds: rm.extraBeds ?? 0,
            extraBedRate: String(rm.extraBedRate ?? 0),
            // Per-room (0017): default the occupant to the booker. The
            // operator can reassign each room to a different guest via
            // POST /reservations/:id/rooms/:roomId/assign-guest after
            // creation. status='confirmed' mirrors the reservation's
            // initial status.
            guestId: input.guestId,
            status: "confirmed" as const,
          })),
        );

        // Migration 0020 — link co-guests (additional adults whose
        // KYC was required at booking). Position is 1-based.
        if (input.coGuestIds && input.coGuestIds.length > 0) {
          await tx.insert(reservationCoGuests).values(
            input.coGuestIds.map((gid, i) => ({
              reservationId: r!.id,
              guestId: gid,
              position: i + 1,
            })),
          );
        }

        await tx
          .update(rooms)
          .set({ status: "reserved", updatedAt: new Date() })
          .where(inArray(rooms.id, roomIds));

        // Always issue a receipt at booking, even when no advance is
        // collected. ₹0 receipts use 'cash' as a placeholder method and
        // carry a different note so reports can distinguish them. The
        // receipt-number sequence is shared with paid receipts.
        {
          const rcpNum = await generateReceiptNumber(tx);
          const amount = input.advancePaid > 0 ? input.advancePaid : 0;
          const method =
            input.advancePaid > 0 && input.advancePaymentMethod
              ? input.advancePaymentMethod
              : "cash";
          const notes =
            input.advancePaid > 0 ? "Advance at booking" : "Booking — no advance collected";
          await tx.insert(payments).values({
            receiptNumber: rcpNum,
            propertyId,
            invoiceId: null,
            reservationId: r!.id,
            amount: String(amount),
            paymentMethod: method,
            receivedBy: req.user!.id,
            notes,
          });
        }

        // Consume the OTP row we pre-verified above, and link it to this
        // reservation so the audit trail shows which booking it unlocked.
        // The conditional WHERE (isNull consumedAt) makes a concurrent
        // replay of the same code lose the race: two bookings that both
        // pre-verified the same valid code can't both consume it — the
        // loser's update matches zero rows and rolls back its reservation.
        if (otpRowIdToConsume) {
          const consumed = await tx
            .update(otps)
            .set({ consumedAt: new Date(), reservationId: r!.id })
            .where(and(eq(otps.id, otpRowIdToConsume), isNull(otps.consumedAt)))
            .returning({ id: otps.id });
          if (consumed.length === 0) {
            throw new Error("OTP was already used — request a new code");
          }
        }

        return r!;
      });
    } catch (err) {
      if (err instanceof Error && err.message === "ROOM_UNAVAILABLE") {
        return fail(res, 409, "ROOM_UNAVAILABLE", `Room is not available for those dates`, {
          roomId: unavailableRoom,
        });
      }
      if (err instanceof Error && err.message === "INSUFFICIENT_WALLET_BALANCE") {
        const info = insufficientRef.value;
        return fail(
          res,
          409,
          "INSUFFICIENT_WALLET_BALANCE",
          `Wallet balance is ₹${info?.available.toFixed(2) ?? "0"} — cannot apply ₹${info?.requested.toFixed(2) ?? "0"}.`,
          info ?? undefined,
        );
      }
      throw err;
    }
    if (!created) {
      return fail(res, 500, "INTERNAL_ERROR", "Reservation creation failed");
    }
    const createdReservation = created;

    await logActivity({
      action: "reservation_created",
      entityType: "reservation",
      entityId: createdReservation.id,
      description: `${createdReservation.reservationNumber} created`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });

    void (async () => {
      try {
        // Complimentary bookings stay silent — no staff notification, no
        // guest/owner WhatsApp. They live only in the Complimentary
        // report. (A booking created directly as complimentary is rare
        // but the guard covers it.)
        if (createdReservation.bookingSource === "complimentary") return;
        const [g] = await db
          .select()
          .from(guests)
          .where(eq(guests.id, createdReservation.guestId))
          .limit(1);

        // Always dispatch the in-app notification.
        const bookedRooms = await getReservationRoomNumbers(createdReservation.id);
        const roomSuffix = bookedRooms ? ` · Room ${bookedRooms}` : "";
        await dispatchNotification({
          type: "reservation_created",
          title: "New booking",
          body: `${createdReservation.reservationNumber} for ${g?.fullName ?? "guest"}${roomSuffix} (${createdReservation.checkInDate} to ${createdReservation.checkOutDate})`,
          href: `/reservations/${createdReservation.id}`,
          payload: { reservationId: createdReservation.id },
          recipientRoles: ["admin", "frontdesk"],
        });

        // Always render the booking receipt — paid or not. ₹0 advances
        // produce a receipt that says "Amount Received ₹0.00, Balance Due
        // <grand total>". The existing booking_advance_* templates are
        // reused; their copy already reads naturally for the ₹0 case
        // since they reference advance_paid + balance, both of which are
        // accurate in either path.
        {
          let receiptLink = "";
          try {
            const [latestPayment] = await db
              .select()
              .from(payments)
              .where(eq(payments.reservationId, createdReservation.id))
              .orderBy(desc(payments.createdAt))
              .limit(1);
            if (latestPayment) {
              const settingsForPdf = await getSettings();
              const pdf = await renderReceiptPdf({
                payment: latestPayment,
                reservation: createdReservation,
                guest: g!,
                invoice: null,
                settings: settingsForPdf,
              });
              const url = await uploadPublicPdf(
                `receipts/${latestPayment.receiptNumber ?? latestPayment.id}.pdf`,
                pdf,
                documentLabel(g!.fullName, g!.phone),
              );
              if (url) receiptLink = url;
            }
          } catch (err) {
            logger.warn(
              { err, reservationId: createdReservation.id },
              "booking receipt PDF render/upload failed",
            );
          }

          const settingsForMsg = await getSettings();
          const receiptBlock = receiptLink ? `\n\nReceipt: ${receiptLink}` : "";
          const baseVars = {
            hotel: env.HOTEL_DISPLAY_NAME,
            hotel_phone: settingsForMsg.hotelPhone ?? "",
            guest_name: g?.fullName ?? "guest",
            guest_phone: g?.phone ?? "",
            guest_email: g?.email ?? "",
            reservation_number: createdReservation.reservationNumber,
            check_in_date: createdReservation.checkInDate,
            check_out_date: createdReservation.checkOutDate,
            total: createdReservation.grandTotal,
            advance_paid: createdReservation.advancePaid,
            balance: createdReservation.balanceDue,
            receipt_link: receiptLink,
            receipt_block: receiptBlock,
          };

          if (g?.phone) {
            const t = await renderTemplate("booking_advance_guest_sms", baseVars);
            if (t.enabled) await notifyGuestSms({ to: g.phone, text: t.body });
          }
          const ownerT = await renderTemplate("booking_advance_owner_sms", baseVars);
          if (ownerT.enabled) await notifyOwner(ownerT.body);
        }
      } catch (err) {
        logger.warn({ err, reservationId: createdReservation.id }, "post-create notification failed");
      }
    })();

    await invalidateDashboard();
    return ok(res, createdReservation, 201);
  },
);

// Returns the projected impact of shifting this reservation's check-in date to
// today, WITHOUT mutating anything. The client uses this for a confirm-impact
// step before actually committing.
router.get(
  "/:id/early-check-in/preview",
  requireAuth,
  requirePermission("view_reservations"),
  async (req, res) => {
    const id = req.params.id!;
    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    const current = r[0]!;
    if (current.status !== "confirmed") {
      return fail(
        res,
        409,
        "INVALID_STATUS",
        `Cannot preview early check-in for a ${current.status} reservation`,
      );
    }

    const today = propertyToday();
    if (current.checkInDate <= today) {
      return fail(res, 400, "NOT_EARLY", "Reservation is not in the future.");
    }
    if (current.checkOutDate <= today) {
      return fail(res, 400, "INVALID_DATES", "Reservation has already passed.");
    }

    const assigned = await db
      .select({ roomId: reservationRooms.roomId, ratePerNight: reservationRooms.ratePerNight })
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, id));

    // Same availability check as the commit endpoint. Surface conflict but
    // don't 409 here — let the UI render the impact AND the conflict together
    // so staff sees the full picture.
    const conflictingRoomIds: string[] = [];
    for (const a of assigned) {
      const ok2 = await isRoomAvailable(a.roomId, today, current.checkInDate, id);
      if (!ok2) conflictingRoomIds.push(a.roomId);
    }

    const oldNights = Number(current.numNights);
    const newNights = differenceInCalendarDays(
      new Date(current.checkOutDate),
      new Date(today),
    );
    const extraNights = newNights - oldNights;

    // Honour inclusive vs exclusive mode (see lib/gst.ts). The amount
    // assembled from rate × nights is treated as a gross total when the
    // property is on inclusive pricing.
    const newRoomAmount = +(
      assigned.reduce((a, rm) => a + Number(rm.ratePerNight) * newNights, 0)
    ).toFixed(2);

    // Inherit the reservation's snapshotted GST rate + mode — DO NOT
    // re-derive from the slab. Adding nights to an existing booking
    // must keep the same tax treatment, otherwise crossing a slab
    // boundary by adding cheap/expensive nights would silently change
    // the tax on rooms that were already priced.
    const newGstRate = Number(current.gstRate);
    const reservationGstMode = current.gstMode ?? "exclusive";
    const {
      subtotal: newSubtotal,
      gstAmount: newGstAmount,
      grandTotal: newGrandTotal,
    } = calcGstBreakdown(newRoomAmount, newGstRate, reservationGstMode);
    const advancePaid = Number(current.advancePaid);
    const newBalanceDue = +(newGrandTotal - advancePaid).toFixed(2);

    return ok(res, {
      today,
      conflictingRoomIds,
      old: {
        checkInDate: current.checkInDate,
        nights: oldNights,
        subtotal: Number(current.subtotal),
        gstRate: Number(current.gstRate),
        gstAmount: Number(current.gstAmount),
        grandTotal: Number(current.grandTotal),
        balanceDue: Number(current.balanceDue),
      },
      new: {
        checkInDate: today,
        nights: newNights,
        subtotal: newSubtotal,
        gstRate: newGstRate,
        gstAmount: newGstAmount,
        grandTotal: newGrandTotal,
        balanceDue: newBalanceDue,
      },
      delta: {
        extraNights,
        subtotalDelta: +(newSubtotal - Number(current.subtotal)).toFixed(2),
        gstAmountDelta: +(newGstAmount - Number(current.gstAmount)).toFixed(2),
        grandTotalDelta: +(newGrandTotal - Number(current.grandTotal)).toFixed(2),
        balanceDueDelta: +(newBalanceDue - Number(current.balanceDue)).toFixed(2),
      },
      advancePaid,
    });
  },
);

// Shifts a reservation's check-in date to today so the guest can be checked
// in early. Verifies every assigned room is available for the extended
// window — refuses if any room is taken by another booking or in maintenance.
// Recomputes subtotal / GST / grand total / balance based on the new night
// count. Does NOT actually perform check-in; the client should follow up with
// POST /reservations/:id/check-in once this returns success.
router.post(
  "/:id/early-check-in",
  requireAuth,
  requirePermission("view_reservations"),
  async (req, res) => {
    const id = req.params.id!;
    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    const current = r[0]!;
    if (current.status !== "confirmed") {
      return fail(
        res,
        409,
        "INVALID_STATUS",
        `Cannot early-check-in a ${current.status} reservation`,
      );
    }

    const today = propertyToday();
    if (current.checkInDate <= today) {
      return fail(
        res,
        400,
        "NOT_EARLY",
        "Reservation is already due today or earlier — use the regular check-in endpoint.",
      );
    }
    if (current.checkOutDate <= today) {
      return fail(
        res,
        400,
        "INVALID_DATES",
        "Reservation has already passed — early check-in not possible.",
      );
    }

    const assigned = await db
      .select({ roomId: reservationRooms.roomId })
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, id));

    let unavailableRoom: string | null = null;
    try {
      await db.transaction(async (tx) => {
        // Deterministic lock order to avoid deadlocks with concurrent creates.
        const sorted = [...assigned.map((a) => a.roomId)].sort();
        for (const rid of sorted) {
          await lockRoom(tx, rid);
        }

        // Verify each room is free for the *new* extended window
        // (today → original checkInDate). Exclude this reservation itself.
        for (const a of assigned) {
          const ok2 = await isRoomAvailable(
            a.roomId,
            today,
            current.checkInDate,
            id,
            tx,
          );
          if (!ok2) {
            unavailableRoom = a.roomId;
            throw new Error("ROOM_UNAVAILABLE");
          }
        }

        // Shift the check-in date and recompute totals. numNights is a
        // generated column derived from (checkOutDate - checkInDate), so we
        // only need to update subtotal / gst / grandTotal / balanceDue.
        const newNights = differenceInCalendarDays(
          new Date(current.checkOutDate),
          new Date(today),
        );
        const roomRates = await tx
          .select({ ratePerNight: reservationRooms.ratePerNight })
          .from(reservationRooms)
          .where(eq(reservationRooms.reservationId, id));

        // Mode-aware totals. `newRoomAmount` is the raw rate × nights;
        // the breakdown helper extracts net subtotal vs grand total
        // depending on inclusive/exclusive mode.
        const newRoomAmount = +(
          roomRates.reduce((a, rm) => a + Number(rm.ratePerNight) * newNights, 0)
        ).toFixed(2);

        // Inherit reservation's snapshot — see /early-check-in/preview.
        const gstRate = Number(current.gstRate);
        const reservationGstMode = current.gstMode ?? "exclusive";
        const avgRate = roomRates.length
          ? newRoomAmount / (newNights * roomRates.length)
          : 0;
        const { subtotal: newSubtotal, gstAmount, grandTotal } = calcGstBreakdown(
          newRoomAmount,
          gstRate,
          reservationGstMode,
        );
            // balanceDue intentionally omitted — recomputeReservationBalance
        // after this update will set it from facts (grandTotal − Σpayments
        // − walletCredit). Keeps the formula consistent across the app.

        await tx
          .update(reservations)
          .set({
            checkInDate: today,
            ratePerNight: String(avgRate.toFixed(2)),
            subtotal: String(newSubtotal),
            gstRate: String(gstRate),
            gstAmount: String(gstAmount),
            grandTotal: String(grandTotal),
            updatedAt: new Date(),
          })
          .where(eq(reservations.id, id));
        await recomputeReservationBalance(tx, id);
      });
    } catch (err) {
      if (err instanceof Error && err.message === "ROOM_UNAVAILABLE") {
        return fail(
          res,
          409,
          "ROOM_UNAVAILABLE",
          "Room is not available for the extended early-check-in window. Cancel or swap the conflicting reservation first.",
          { roomId: unavailableRoom },
        );
      }
      throw err;
    }

    await logActivity({
      action: "early_check_in",
      entityType: "reservation",
      entityId: id,
      description: `${current.reservationNumber} early check-in: dates shifted from ${current.checkInDate} → ${today}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { originalCheckIn: current.checkInDate, newCheckIn: today },
    });
    await invalidateDashboard();

    const [updated] = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    return ok(res, updated);
  },
);

router.post(
  "/:id/check-in",
  requireAuth,
  requirePermission("view_reservations"),
  idempotent("reservations.checkIn"),
  validate(checkInSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as import("@stayvia/shared").CheckInInput;

    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (r[0]!.status !== "confirmed") {
      return fail(res, 409, "INVALID_STATUS", `Cannot check in a ${r[0]!.status} reservation`);
    }

    // Block early check-in. Use the early-check-in endpoint to shift dates and
    // re-verify room availability for the extra nights.
    const today = propertyToday();
    if (r[0]!.checkInDate > today) {
      return fail(
        res,
        409,
        "EARLY_CHECK_IN",
        `Reservation is for ${r[0]!.checkInDate}. To check in early on ${today}, the booking dates must be shifted and rooms re-verified.`,
        { reservationCheckInDate: r[0]!.checkInDate, today },
      );
    }

    const guestRow = await db
      .select({
        kycVerifiedAt: guests.kycVerifiedAt,
        idProofPhotoFront: guests.idProofPhotoFront,
        guestPhoto: guests.guestPhoto,
      })
      .from(guests)
      .where(eq(guests.id, r[0]!.guestId))
      .limit(1);
    if (!guestRow.length || !guestRow[0]!.kycVerifiedAt || !guestRow[0]!.idProofPhotoFront) {
      return fail(
        res,
        422,
        "KYC_REQUIRED",
        "Guest KYC documents required before check-in. Upload ID proof photo first.",
      );
    }
    if (!guestRow[0]!.guestPhoto) {
      return fail(
        res,
        422,
        "PHOTO_REQUIRED",
        "Customer photo required before check-in. Upload via the KYC documents button.",
      );
    }

    // OTP gate — only enforced when the property requires it. When OTP is
    // turned off in Settings, no code is ever sent/verified, so there's no
    // consumed row to look for; requiring one would make check-in impossible.
    // We read the setting server-side (not a client flag) so it can't be
    // bypassed. The purpose="checkin" scope stays so this never touches
    // auth/password OTP.
    const { otpRequiredForCheckin } = await getSettings();
    if (otpRequiredForCheckin) {
      const otpRow = await db
        .select({ id: otps.id })
        .from(otps)
        .where(
          and(
            eq(otps.reservationId, id),
            eq(otps.purpose, "checkin"),
            isNotNull(otps.consumedAt),
            gte(otps.consumedAt, sql`now() - interval '15 minutes'`),
          ),
        )
        .limit(1);
      if (!otpRow.length) {
        return fail(
          res,
          422,
          "OTP_REQUIRED",
          "OTP verification required. Send and verify a code before check-in.",
        );
      }
    }

    const roomIds = (
      await db
        .select({ roomId: reservationRooms.roomId })
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, id))
    ).map((x) => x.roomId);

    await db.transaction(async (tx) => {
      // Status flip only — the advancePaid + balanceDue numbers will be
      // recomputed at the end of this tx from the payments table, which
      // is the single source of truth.
      await tx
        .update(reservations)
        .set({
          status: "checked_in",
          checkedInAt: new Date(),
          checkedInBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, id));
      await tx
        .update(rooms)
        .set({ status: "occupied", updatedAt: new Date() })
        .where(inArray(rooms.id, roomIds));

      // Per-room (0017): the bulk check-in flips every room on this
      // reservation that isn't already checked-out or cancelled.
      // Staff that wants to check rooms in individually instead would
      // use the per-room endpoint (future) and skip this bulk action.
      await tx
        .update(reservationRooms)
        .set({
          status: "checked_in",
          checkedInAt: new Date(),
          checkedInBy: req.user!.id,
        })
        .where(
          and(
            eq(reservationRooms.reservationId, id),
            inArray(reservationRooms.status, ["confirmed"] as const),
          ),
        );

      // Issue a check-in receipt ONLY when an additional payment was
      // actually collected at the desk. The previous "always emit a
      // ₹0 receipt as audit acknowledgement" pattern produced
      // confusing "Check-in — no advance collected" rows next to
      // the real Advance-at-booking row in Payment History. The
      // check-in event itself is already logged in activity_log
      // (action='check_in'), so no audit data is lost by skipping
      // the placeholder row.
      const advance = input.advancePayment ?? 0;
      if (advance > 0) {
        const rcpNum = await generateReceiptNumber(tx);
        const method = input.paymentMethod ?? "cash";
        await tx.insert(payments).values({
          receiptNumber: rcpNum,
          propertyId: r[0]!.propertyId,
          invoiceId: null,
          reservationId: id,
          amount: String(advance),
          paymentMethod: method,
          receivedBy: req.user!.id,
          notes: "Advance at check-in",
        });
      }
      // Roll advancePaid + balanceDue forward from the payment we just
      // recorded (and anything else previously paid on this reservation).
      await recomputeReservationBalance(tx, id);
    });

    await logActivity({
      action: "check_in",
      entityType: "reservation",
      entityId: id,
      description: `${r[0]!.reservationNumber} checked in`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { advancePayment: input.advancePayment ?? 0 },
    });

    void (async () => {
      try {
        // Complimentary bookings are silent everywhere — skip check-in
        // notification + guest/owner WhatsApp.
        if (r[0]!.bookingSource === "complimentary") return;
        const [g] = await db.select().from(guests).where(eq(guests.id, r[0]!.guestId)).limit(1);
        const roomNumbers = (
          await db
            .select({ n: rooms.roomNumber })
            .from(reservationRooms)
            .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
            .where(eq(reservationRooms.reservationId, id))
        )
          .map((r) => r.n)
          .join(", ");

        // Re-read fresh reservation totals (advance was just applied in the tx)
        const [fresh] = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
        const total = fresh?.grandTotal ?? r[0]!.grandTotal;
        const advancePaid = fresh?.advancePaid ?? r[0]!.advancePaid;
        const balance = fresh?.balanceDue ?? r[0]!.balanceDue;

        const settings = await getSettings();

        // Always render the check-in receipt PDF — paid or not. The
        // payment row was inserted above regardless of advance amount, so
        // there's always exactly one fresh row to render.
        let receiptLink = "";
        try {
          const [latestPayment] = await db
            .select()
            .from(payments)
            .where(eq(payments.reservationId, id))
            .orderBy(desc(payments.createdAt))
            .limit(1);
          if (latestPayment) {
            const pdf = await renderReceiptPdf({
              payment: latestPayment,
              reservation: r[0]!,
              guest: g!,
              invoice: null,
              settings,
            });
            const url = await uploadPublicPdf(
              `receipts/${latestPayment.receiptNumber ?? latestPayment.id}.pdf`,
              pdf,
              documentLabel(g!.fullName, g!.phone),
            );
            if (url) receiptLink = url;
          }
        } catch (err) {
          logger.warn({ err, reservationId: id }, "check-in receipt PDF render/upload failed");
        }

        const wifiBlock =
          settings.wifiSsid && settings.wifiPassword
            ? `\n📶 Wi-Fi: ${settings.wifiSsid} / ${settings.wifiPassword}`
            : "";
        const receiptBlock = receiptLink ? `\n\nView receipt: ${receiptLink}` : "";

        const baseVars = {
          hotel: env.HOTEL_DISPLAY_NAME,
          hotel_phone: settings.hotelPhone ?? "",
          wifi_ssid: settings.wifiSsid ?? "",
          wifi_password: settings.wifiPassword ?? "",
          wifi_block: wifiBlock,
          guest_name: g?.fullName ?? "guest",
          guest_phone: g?.phone ?? "",
          guest_email: g?.email ?? "",
          reservation_number: r[0]!.reservationNumber,
          check_in_date: r[0]!.checkInDate,
          check_out_date: r[0]!.checkOutDate,
          room_numbers: roomNumbers,
          total,
          advance_paid: advancePaid,
          balance,
          receipt_link: receiptLink,
          receipt_block: receiptBlock,
        };
        await dispatchNotification({
          type: "guest_checked_in",
          title: "Guest checked in",
          body: `${g?.fullName ?? "Guest"} checked in (${r[0]!.reservationNumber}${roomNumbers ? ` · Room ${roomNumbers}` : ""})`,
          href: `/reservations/${id}`,
          payload: { reservationId: id },
          recipientRoles: ["admin", "frontdesk", "housekeeping"],
        });
        if (g?.phone) {
          const t = await renderTemplate("checkin_guest_sms", baseVars);
          if (t.enabled) await notifyGuestSms({ to: g.phone, text: t.body });
        }
        const ownerT = await renderTemplate("checkin_owner_sms", baseVars);
        if (ownerT.enabled) await notifyOwner(ownerT.body);
      } catch (err) {
        logger.warn({ err, reservationId: id }, "post-check-in notification failed");
      }
    })();

    await invalidateDashboard();
    return ok(res, { success: true });
  },
);

// Close-only checkout — used when every room on the reservation already
// has its own invoice (someone per-room checked them out earlier in the
// stay). There's no new invoice to issue and no payment to take; the
// stay just needs to be wrapped up so the rooms move to dirty and the
// reservation flips to checked_out.
async function closeOnlyCheckout(args: {
  req: import("express").Request;
  res: import("express").Response;
  reservation: typeof reservations.$inferSelect;
  resRooms: Array<{
    rr: typeof reservationRooms.$inferSelect;
    room: typeof rooms.$inferSelect;
  }>;
}) {
  const { req, res, reservation: r, resRooms } = args;
  const id = r.id;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(reservations)
      .set({
        status: "checked_out",
        checkedOutAt: now,
        checkedOutBy: req.user!.id,
        updatedAt: now,
      })
      .where(eq(reservations.id, id));

    // Flip every still-checked-in per-room row to checked_out.
    await tx
      .update(reservationRooms)
      .set({
        status: "checked_out",
        checkedOutAt: now,
        checkedOutBy: req.user!.id,
      })
      .where(
        and(
          eq(reservationRooms.reservationId, id),
          inArray(reservationRooms.status, ["confirmed", "checked_in"] as const),
        ),
      );

    // Move every room on the reservation to dirty so housekeeping can
    // pick them up. Rooms that were already dirty from per-room checkout
    // stay dirty (no harm in idempotent updates).
    const allRoomIds = resRooms.map((x) => x.room.id);
    if (allRoomIds.length > 0) {
      await tx
        .update(rooms)
        .set({ status: "dirty", updatedAt: now })
        .where(inArray(rooms.id, allRoomIds));
    }
  });

  await logActivity({
    action: "reservation_closed",
    entityType: "reservation",
    entityId: id,
    description: `${r.reservationNumber}: stay closed (all rooms previously invoiced)`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
  });
  await invalidateDashboard();
  return ok(res, { success: true, closedOnly: true });
}

// Per-room checkout handler. Issues one tax invoice per still-un-invoiced
// room, splits the staff-entered finalPayment proportionally across those
// invoices, and runs the same status flips + housekeeping task creation as
// the combined path. Charges with a roomId go to that room's invoice;
// reservation-wide (room-NULL) charges land on the FIRST room's invoice so
// they don't disappear and don't double-count (matches the per-room
// invoice endpoint's behaviour).
async function handlePerRoomCheckout(args: {
  req: import("express").Request;
  res: import("express").Response;
  reservation: typeof reservations.$inferSelect;
  guest: typeof guests.$inferSelect;
  resRooms: Array<{
    rr: typeof reservationRooms.$inferSelect;
    room: typeof rooms.$inferSelect;
  }>;
  charges: Array<typeof additionalCharges.$inferSelect>;
  labelMap: RoomTypeLabelMap;
  settings: Awaited<ReturnType<typeof getSettings>>;
  input: import("@stayvia/shared").CheckOutInput;
}) {
  const { req, res, reservation: r, guest, resRooms, charges, labelMap, settings, input } = args;
  const id = r.id;

  // Only rooms that don't yet have an invoice are in scope. Already-
  // invoiced rooms (someone checked them out individually earlier) stay
  // as they are — their invoice + payment are untouched.
  const targetRooms = resRooms.filter((x) => !x.rr.invoiceId);
  if (targetRooms.length === 0) {
    // Close-only path: every room was already invoiced via the per-room
    // flow during the stay. No new invoice to issue and no money to
    // collect (those invoices were settled individually). Just flip the
    // reservation to checked_out, mark all rooms dirty, and let the
    // caller move on.
    return await closeOnlyCheckout({ req, res, reservation: r, resRooms });
  }

  // Pre-build each invoice (math only, no DB writes yet) so we know the
  // total and can split the final payment proportionally.
  const targetRoomIds = targetRooms.map((x) => x.room.id);
  // Resolved once for every room in the checkout (the .map below is sync) —
  // lets in-place swaps render "swapped from Room X" on the invoice line.
  const roomNumberById = await buildRoomNumberMap(resRooms);
  const swapHopsByRowId = await buildSwapHopsMap(resRooms.map((x) => x.rr.id));
  const builts = targetRooms.map((rrm, idx) => {
    // Pin orphan (room-NULL) charges to the FIRST target room — they only
    // appear on one invoice so they don't double-count. selectChargesForScope
    // attaches orphans only when scope == remaining; for non-first rooms we
    // pass an OTHER-room placeholder for "remaining" so the helper sees the
    // scope as a STRICT subset and excludes the orphans. For the first
    // room we make scope == remaining so the orphans are picked up.
    const scopedCharges = selectChargesForScope({
      allCharges: charges,
      scopeRoomIds: [rrm.room.id],
      remainingUnInvoicedRoomIds:
        idx === 0
          ? [rrm.room.id]
          : [rrm.room.id, ...targetRoomIds.filter((id) => id !== rrm.room.id)],
    });
    const built = buildInvoice({
      reservation: {
        stayType: r.stayType,
        durationHours: r.durationHours,
        checkInDate: r.checkInDate,
        checkOutDate: r.checkOutDate,
        numNights: r.numNights,
        gstRate: r.gstRate,
        gstMode: r.gstMode,
      },
      rooms: [{ ...rrm.rr, room: rrm.room }] as never,
      charges: scopedCharges,
      labelMap,
      roomNumberById,
      swapHopsByRowId,
    });
    return { rrm, built };
  });

  const totalGrand = +builts.reduce((s, b) => s + b.built.grandTotal, 0).toFixed(2);
  // advance_paid is reservation-wide and includes money already consumed
  // by invoices issued earlier in the stay (per-room early check-outs).
  // Only orphan payment rows (invoice_id IS NULL) can still pay for the
  // rooms billed here — counting the rest manufactures a phantom
  // "overpayment" and offers to refund money that's already settled on a
  // sibling invoice.
  const [orphanPaid] = await db
    .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text` })
    .from(payments)
    .where(
      and(
        eq(payments.reservationId, id),
        sql`${payments.invoiceId} IS NULL`,
        eq(payments.voided, false),
        eq(payments.status, "received"),
      ),
    );
  const previouslyPaid = Number(orphanPaid?.total ?? 0);
  const walletCreditApplied = Number(r.walletCreditApplied ?? 0);
  const finalPayment = input.finalPayment ?? 0;
  const isUnpaid = input.paymentMethod === "unpaid";

  const remainingBeforeFinal = +(totalGrand - previouslyPaid - walletCreditApplied).toFixed(2);
  if (remainingBeforeFinal > 0.009) {
    if (!input.paymentMethod) {
      return fail(res, 400, "PAYMENT_REQUIRED", "Payment method is required at check-out");
    }
    if (finalPayment <= 0.009) {
      return fail(res, 400, "PAYMENT_REQUIRED", "Final payment amount is required at check-out");
    }
    if (isUnpaid && (!input.paymentNotes || input.paymentNotes.trim() === "")) {
      return fail(res, 400, "NOTES_REQUIRED", "Notes are required for unpaid checkouts");
    }
  }

  // Distribute previouslyPaid + walletCreditApplied + finalPayment across
  // the per-room invoices proportionally to each invoice's grandTotal.
  // Wallet credit + advance attach to the FIRST invoice so the receipt
  // trail stays sane (a single "advance carry-in" row, not N slivers).
  const realFinalPaid = isUnpaid ? 0 : finalPayment;
  const totalCollected = +(previouslyPaid + walletCreditApplied + realFinalPaid).toFixed(2);
  const hasOverpaid = totalCollected - totalGrand > 0.009;
  const overpaidAmount = +(totalCollected - totalGrand).toFixed(2);
  if (hasOverpaid && !input.refundMode) {
    return fail(
      res,
      400,
      "REFUND_MODE_REQUIRED",
      `Guest overpaid by ₹${overpaidAmount.toFixed(2)}. Choose refund mode (cash or credit).`,
    );
  }

  // For payment splitting: how much of the staff's final payment goes to
  // each invoice (proportional to that invoice's bill, after accounting
  // for the advance + wallet that lands on invoice #0).
  const advanceForFirst = +(previouslyPaid + walletCreditApplied).toFixed(2);
  // Each invoice's "billed minus pre-paid" determines how much real money
  // it still needs from the finalPayment pool.
  const owedPerInvoice = builts.map((b, idx) => {
    const carry = idx === 0 ? Math.min(advanceForFirst, b.built.grandTotal) : 0;
    return +(b.built.grandTotal - carry).toFixed(2);
  });
  const totalStillOwed = +owedPerInvoice.reduce((s, x) => s + x, 0).toFixed(2);
  const splitFinal = owedPerInvoice.map((owed, idx) => {
    if (totalStillOwed <= 0.009) return 0;
    // Last invoice absorbs the rounding remainder.
    if (idx === owedPerInvoice.length - 1) {
      const used = +owedPerInvoice
        .slice(0, -1)
        .reduce(
          (s, _, i) => s + +((realFinalPaid * (owedPerInvoice[i] ?? 0)) / totalStillOwed).toFixed(2),
          0,
        )
        .toFixed(2);
      return +(realFinalPaid - used).toFixed(2);
    }
    return +((realFinalPaid * owed) / totalStillOwed).toFixed(2);
  });

  const issuedInvoices: Array<{ id: string; invoiceNumber: string }> = [];

  await db.transaction(async (tx) => {
    for (let i = 0; i < builts.length; i++) {
      const { rrm, built } = builts[i]!;
      const invoiceSeq = await nextInvoiceSequence(`SLDT-INV-%`, tx);
      const invNum = invoiceNumber(settings.invoicePrefix, invoiceSeq);

      const cgstRate = +(built.roomGstRate / 2).toFixed(2);
      const sgstRate = +(built.roomGstRate / 2).toFixed(2);

      // Per-room invoice bills the room's occupant by default, falling
      // back to the booker (matches /:id/invoice scope=room behaviour).
      const billedToGuestId = rrm.rr.guestId;
      const [billedTo] = await tx
        .select()
        .from(guests)
        .where(eq(guests.id, billedToGuestId))
        .limit(1);
      const billedToGuest = billedTo ?? guest;

      const advanceOnThisInv = i === 0 ? Math.min(advanceForFirst, built.grandTotal) : 0;
      const paymentOnThisInv = splitFinal[i] ?? 0;
      const collectedOnThisInv = +(advanceOnThisInv + paymentOnThisInv).toFixed(2);
      const balanceOnThisInv = +(built.grandTotal - collectedOnThisInv).toFixed(2);
      const invStatusForRow =
        balanceOnThisInv <= 0.009 ? "paid" : collectedOnThisInv > 0 ? "partial" : "issued";

      const [inv] = await tx
        .insert(invoices)
        .values({
          invoiceNumber: invNum,
          propertyId: r.propertyId,
          reservationId: id,
          guestId: billedToGuestId,
          hotelName: settings.hotelName,
          hotelAddress: settings.hotelAddress,
          hotelGstin: settings.hotelGstin,
          guestName: billedToGuest.fullName,
          guestAddress: billedToGuest.address ?? null,
          guestGstin: billedToGuest.gstin ?? null,
          subtotal: String(built.subtotal),
          cgstRate: String(cgstRate),
          cgstAmount: String(built.cgst),
          sgstRate: String(sgstRate),
          sgstAmount: String(built.sgst),
          grandTotal: String(built.grandTotal),
          // Wallet credit only attaches to the first invoice (the booker's
          // wallet pays the booker's share).
          walletCreditApplied: i === 0 ? String(walletCreditApplied.toFixed(2)) : "0.00",
          totalPaid: String(collectedOnThisInv),
          balanceDue: String(balanceOnThisInv),
          status: invStatusForRow,
          scope: "room" as const,
          scopeRoomIds: [rrm.room.id],
          issuedBy: req.user!.id,
        })
        .returning();

      await tx
        .insert(invoiceLineItems)
        .values(built.lineItems.map((li) => ({ invoiceId: inv!.id, ...li })));

      // Link reservation_room → its invoice for the per-room queries.
      await tx
        .update(reservationRooms)
        .set({
          invoiceId: inv!.id,
          status: "checked_out",
          checkedOutAt: new Date(),
          checkedOutBy: req.user!.id,
        })
        .where(eq(reservationRooms.id, rrm.rr.id));

      if (paymentOnThisInv > 0.009 && input.paymentMethod) {
        const rcpNum = await generateReceiptNumber(tx);
        await tx.insert(payments).values({
          receiptNumber: rcpNum,
          propertyId: r.propertyId,
          invoiceId: inv!.id,
          reservationId: id,
          amount: String(paymentOnThisInv),
          paymentMethod: input.paymentMethod,
          status: isUnpaid ? "pending" : "received",
          receivedBy: req.user!.id,
          notes:
            input.paymentNotes ??
            (builts.length > 1 ? `Per-room share of check-out collection (Room ${rrm.room.roomNumber})` : null),
        });
      }

      issuedInvoices.push({ id: inv!.id, invoiceNumber: invNum });
    }

    // Refund the overpayment. Credit → wallet ledger entry. Cash → a
    // negative payment row (money out), mirroring the cancel flow, so the
    // refund is an auditable transaction that nets advance_paid down and
    // shows on the invoice — not just an activity-log note.
    if (hasOverpaid && input.refundMode === "credit") {
      await tx.insert(guestLedger).values({
        guestId: r.guestId,
        entryType: "credit_issued",
        amount: String(overpaidAmount.toFixed(2)),
        reservationId: id,
        invoiceId: issuedInvoices[0]!.id,
        note:
          input.refundNote ??
          `Refund issued as wallet credit on early checkout (reservation ${r.reservationNumber})`,
        createdBy: req.user!.id,
      });
    } else if (hasOverpaid && input.refundMode === "cash") {
      const rcpNum = await generateReceiptNumber(tx);
      await tx.insert(payments).values({
        receiptNumber: rcpNum,
        propertyId: r.propertyId,
        invoiceId: issuedInvoices[0]!.id,
        reservationId: id,
        amount: String((-overpaidAmount).toFixed(2)),
        paymentMethod: "cash",
        status: "received",
        receivedBy: req.user!.id,
        notes:
          input.refundNote ??
          `Cash refund of overpayment on check-out (reservation ${r.reservationNumber})`,
      });
    }

    // Attach any orphan (no invoice_id) payments to the LAST invoice in
    // this batch — that's the actual room the guest stayed in (the
    // primary leg), not the swap-leg micro-invoice that might be first
    // in the loop. After that, recompute invoice + reservation totals
    // from facts so the picture matches reality. This corrects the
    // historical "advance disappears into the swap leg" bug and the
    // "forward-credited payment never lands on its real invoice" bug.
    if (issuedInvoices.length > 0) {
      const primaryInvoiceId = issuedInvoices[issuedInvoices.length - 1]!.id;
      await attachOrphanPaymentsAndRecompute(tx, id, primaryInvoiceId);
    }

    await tx
      .update(reservations)
      .set({
        status: "checked_out",
        checkedOutAt: new Date(),
        checkedOutBy: req.user!.id,
        updatedAt: new Date(),
      })
      .where(eq(reservations.id, id));
    // balanceDue is already set by the recompute above; do it again so
    // the final number reflects status=checked_out side effects (none
    // currently, but safe).
    await recomputeReservationBalance(tx, id);

    const checkoutRoomIds = targetRooms.map((x) => x.room.id);
    await tx
      .update(rooms)
      .set({ status: "dirty", updatedAt: new Date() })
      .where(inArray(rooms.id, checkoutRoomIds));
  });

  // Fire-and-forget post-checkout work — PDFs per invoice, owner +
  // guest notifications. Matches the combined path's behaviour but
  // loops over every invoice we just issued.
  void (async () => {
    try {
      // Complimentary bookings: no checkout notification / WhatsApp.
      if (r.bookingSource === "complimentary") return;
      const settingsCo = await getSettings();
      // Phone for the PDF filename tag ("Name-Phone") — invoices carry only
      // the guest's name, so resolve the phone once for the whole loop.
      const [gCo] = await db
        .select({ phone: guests.phone })
        .from(guests)
        .where(eq(guests.id, r.guestId))
        .limit(1);
      const gCoPhone = gCo?.phone ?? null;
      const invoiceLinks: string[] = [];
      for (const issued of issuedInvoices) {
        try {
          const [fullInv] = await db
            .select()
            .from(invoices)
            .where(eq(invoices.id, issued.id))
            .limit(1);
          if (!fullInv) continue;
          const [items, pays] = await Promise.all([
            db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, fullInv.id)),
            db.select().from(payments).where(eq(payments.invoiceId, fullInv.id)),
          ]);
          const pdf = await renderInvoicePdf({
            invoice: fullInv,
            lineItems: items,
            payments: pays,
            settings: settingsCo,
            stay: {
              checkInDate: r.checkInDate,
              checkOutDate: r.checkOutDate,
              numNights: Number(r.numNights),
              stayType: r.stayType,
              durationHours: r.durationHours ? Number(r.durationHours) : null,
              checkedInAt: r.checkedInAt ? r.checkedInAt.toISOString() : null,
              plannedCheckInAt: r.plannedCheckInAt
                ? r.plannedCheckInAt.toISOString()
                : null,
              plannedCheckOutAt: r.plannedCheckOutAt
                ? r.plannedCheckOutAt.toISOString()
                : null,
            },
            guestExtra: await loadGuestExtra(r.id),
          });
          const url = await uploadPublicPdf(`invoices/${issued.invoiceNumber}.pdf`, pdf, documentLabel(fullInv.guestName, gCoPhone));
          if (url) invoiceLinks.push(url);
        } catch (err) {
          logger.warn(
            { err, invoiceNumber: issued.invoiceNumber },
            "invoice PDF render/upload failed",
          );
        }
      }

      const checkedOutRooms = await getReservationRoomNumbers(id);
      const coRoomSuffix = checkedOutRooms ? ` · Room ${checkedOutRooms}` : "";
      const summaryNumbers = issuedInvoices.map((x) => x.invoiceNumber).join(", ");
      await dispatchNotification({
        type: "guest_checked_out",
        title: "Guest checked out",
        body: `${guest.fullName} (${r.reservationNumber}${coRoomSuffix}). Invoices: ${summaryNumbers}.`,
        href: `/reservations/${id}`,
        payload: {
          reservationId: id,
          invoiceNumbers: issuedInvoices.map((x) => x.invoiceNumber),
          invoiceLinks,
        },
        recipientRoles: ["admin", "frontdesk", "housekeeping"],
      });

      const baseVars = {
        hotel: env.HOTEL_DISPLAY_NAME,
        hotel_phone: settingsCo.hotelPhone ?? "",
        guest_name: guest.fullName,
        guest_phone: guest.phone ?? "",
        guest_email: guest.email ?? "",
        reservation_number: r.reservationNumber,
        check_out_date: r.checkOutDate,
        invoice_number: summaryNumbers,
        invoice_link: invoiceLinks[0] ?? "",
        total: String(totalGrand),
      };
      if (guest.phone) {
        const t = await renderTemplate("checkout_guest_sms", baseVars);
        if (t.enabled) await notifyGuestSms({ to: guest.phone, text: t.body });
      }
      const ownerT = await renderTemplate("checkout_owner_sms", baseVars);
      if (ownerT.enabled) await notifyOwner(ownerT.body);
    } catch (err) {
      logger.warn({ err, reservationId: id }, "per-room post-check-out work failed");
    }
  })();

  await logActivity({
    action: "check_out",
    entityType: "reservation",
    entityId: id,
    description: `${r.reservationNumber} checked out, ${issuedInvoices.length} per-room invoice${issuedInvoices.length === 1 ? "" : "s"} issued`,
    performedBy: req.user!.id,
    ipAddress: req.ip,
    metadata: {
      invoiceMode: "per_room",
      invoiceIds: issuedInvoices.map((x) => x.id),
      finalPayment,
      overpaidAmount: hasOverpaid ? overpaidAmount : 0,
      refundMode: hasOverpaid ? input.refundMode : null,
    },
  });
  await invalidateDashboard();
  return ok(res, { invoices: issuedInvoices });
}

router.post(
  "/:id/check-out",
  requireAuth,
  requirePermission("view_reservations"),
  idempotent("reservations.checkOut"),
  validate(checkOutSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as import("@stayvia/shared").CheckOutInput;

    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (r[0]!.status !== "checked_in") {
      return fail(res, 409, "INVALID_STATUS", `Cannot check out a ${r[0]!.status} reservation`);
    }

    const settings = await getSettings();
    const guest = (await db.select().from(guests).where(eq(guests.id, r[0]!.guestId)).limit(1))[0]!;
    const resRooms = await db
      .select({ rr: reservationRooms, room: rooms })
      .from(reservationRooms)
      .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
      .where(eq(reservationRooms.reservationId, id));
    const charges = await db
      .select()
      .from(additionalCharges)
      .where(eq(additionalCharges.reservationId, id));
    const labelMap = await buildRoomTypeLabelMap();

    // Per-room invoicing branch. Default behaviour for multi-room
    // checkouts — each remaining un-invoiced room gets its own tax
    // invoice (so each occupant can claim their own GST). The combined
    // branch below stays as an opt-in via invoiceMode='combined'.
    const invoiceMode = input.invoiceMode ?? "per_room";
    if (invoiceMode === "per_room") {
      return await handlePerRoomCheckout({
        req,
        res,
        reservation: r[0]!,
        guest,
        resRooms,
        charges,
        labelMap,
        settings,
        input,
      });
    }

    const isShortStayInvoice = r[0]!.stayType === "short_stay";
    const shortStayHours = Number(r[0]!.durationHours ?? 0);
    const nights = Number(r[0]!.numNights);
    // For short_stay the room line is one flat charge (quantity 1, rate =
    // the FLAT short-stay price stored on reservation_rooms.ratePerNight).
    // For overnight we keep the original "rate × nights" line.
    const roomUnits = isShortStayInvoice ? 1 : nights;
    const roomGstRate = Number(r[0]!.gstRate);
    const reservationGstMode = r[0]!.gstMode ?? "exclusive";

    // Combined branch: only bill rooms (and per-room charges) that don't
    // already have an invoice. Without this filter the combined invoice
    // would double-bill any room that was per-room checked out earlier in
    // the stay (e.g. the early-leaver who already paid via the per-room
    // flow). Reservation-wide charges (room_id == null) still belong on
    // the combined invoice — they were never billed elsewhere.
    const billableRooms = resRooms.filter((x) => !x.rr.invoiceId);
    if (billableRooms.length === 0) {
      // See handlePerRoomCheckout: when every room is already invoiced
      // there's nothing left to bill OR combine. Close the stay so
      // staff can wrap up.
      return await closeOnlyCheckout({
        req,
        res,
        reservation: r[0]!,
        resRooms,
      });
    }
    const billableRoomIds = new Set(billableRooms.map((x) => x.room.id));
    const billableCharges = charges.filter(
      (c) => c.roomId == null || billableRoomIds.has(c.roomId),
    );

    let subtotal = 0;
    const lineItems: Array<{
      description: string;
      sacCode: string;
      quantity: number;
      rate: string;
      amount: string;
      gstRate: string;
      gstAmount: string;
      itemType: "room_charge" | "additional_charge";
    }> = [];

    for (const rr of billableRooms) {
      // In exclusive mode the stored rate IS the net price per unit.
      // In inclusive mode the stored rate is the gross per unit, so we
      // extract the per-unit net via the breakdown helper and store
      // that as the line item's `rate` and `amount` (×qty). The
      // breakdown's grand_total == stored gross == what the guest pays.
      const storedRate = Number(rr.rr.ratePerNight);
      const lineGross = +(storedRate * roomUnits).toFixed(2);
      const lineBreakdown = calcGstBreakdown(lineGross, roomGstRate, reservationGstMode);
      const netRate =
        reservationGstMode === "inclusive" && roomUnits > 0
          ? +(lineBreakdown.subtotal / roomUnits).toFixed(2)
          : storedRate;
      const amount = lineBreakdown.subtotal;
      const gstAmount = lineBreakdown.gstAmount;
      subtotal += amount;
      // If staff used the "Sell as" picker on the booking form, show both:
      // "<physical> booked as <sold-as>". If no override, show just the
      // physical label. See lib/roomTypeLabel.ts.
      const displayType = combinedRoomTypeLabel(
        rr.room.roomType,
        rr.rr.soldAsType,
        labelMap,
      );
      const description = isShortStayInvoice
        ? `Room ${rr.room.roomNumber} - ${displayType} (Day use · ${shortStayHours} hours)`
        : `Room ${rr.room.roomNumber} - ${displayType} (${nights} nights)`;
      lineItems.push({
        description,
        // 996311 — Room/unit accommodation services by hotels, inn, guest
        // houses. The precise SAC for hotel room nights. 9963 (chapter)
        // is still valid but 996311 is the recommended 6-digit form.
        sacCode: "996311",
        quantity: roomUnits,
        rate: String(netRate),
        amount: String(amount),
        gstRate: String(roomGstRate),
        gstAmount: String(gstAmount),
        itemType: "room_charge",
      });

      // Extra beds (additional persons) for this room, billed at the same
      // GST slab as the room. Quantity = beds × units; rate = per-bed,
      // per-unit fee. Emitted as its own line so the bill itemises it.
      const beds = Number(rr.rr.extraBeds ?? 0);
      const bedRate = Number(rr.rr.extraBedRate ?? 0);
      if (beds > 0 && bedRate > 0) {
        const bedQty = beds * roomUnits;
        const bedGross = +(bedRate * bedQty).toFixed(2);
        const bedBreakdown = calcGstBreakdown(bedGross, roomGstRate, reservationGstMode);
        const bedNetRate =
          reservationGstMode === "inclusive" && bedQty > 0
            ? +(bedBreakdown.subtotal / bedQty).toFixed(2)
            : bedRate;
        subtotal += bedBreakdown.subtotal;
        lineItems.push({
          description: `Room ${rr.room.roomNumber} - Extra bed (${beds} × ${roomUnits} ${isShortStayInvoice ? "day" : "night"}${roomUnits === 1 && beds === 1 ? "" : "s"})`,
          sacCode: "996311",
          quantity: bedQty,
          rate: String(bedNetRate),
          amount: String(bedBreakdown.subtotal),
          gstRate: String(roomGstRate),
          gstAmount: String(bedBreakdown.gstAmount),
          itemType: "room_charge",
        });
      }
    }

    // The room GST is already captured per-line above. Sum it instead of
    // applying the rate to the subtotal again (which would double-count
    // in inclusive mode and slightly drift in exclusive mode).
    let totalGst = +lineItems
      .reduce((s, li) => s + Number(li.gstAmount), 0)
      .toFixed(2);
    for (const c of billableCharges) {
      const amount = Number(c.amount);
      const gstAmount = +(amount * (Number(c.gstRate) / 100)).toFixed(2);
      subtotal += amount;
      totalGst += gstAmount;
      lineItems.push({
        description: c.description,
        // 9963 (chapter-level) for misc additional charges. Restaurant,
        // laundry etc. have their own 6-digit codes — if you start
        // categorising charges in Settings, swap to the specific one.
        sacCode: "9963",
        quantity: c.quantity,
        rate: String(c.rate),
        amount: String(amount),
        gstRate: String(c.gstRate),
        gstAmount: String(gstAmount),
        itemType: "additional_charge",
      });
    }

    subtotal = +subtotal.toFixed(2);
    totalGst = +totalGst.toFixed(2);
    const cgst = +(totalGst / 2).toFixed(2);
    const sgst = +(totalGst - cgst).toFixed(2);
    const grandTotal = +(subtotal + totalGst).toFixed(2);

    const finalPayment = input.finalPayment ?? 0;
    // Same rule as the per-room branch: only orphan payments are still
    // available to pay for the rooms billed here. Money attached to
    // earlier per-room invoices is already spent — counting it again
    // fabricates an overpayment/refund.
    const [orphanPaid] = await db
      .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text` })
      .from(payments)
      .where(
        and(
          eq(payments.reservationId, id),
          sql`${payments.invoiceId} IS NULL`,
          eq(payments.voided, false),
          eq(payments.status, "received"),
        ),
      );
    const previouslyPaid = Number(orphanPaid?.total ?? 0);
    // Wallet credit already applied to this reservation reduces what's owed
    // at checkout — count it just like cash already paid in.
    const walletCreditApplied = Number(r[0]!.walletCreditApplied ?? 0);
    const isUnpaid = input.paymentMethod === "unpaid";

    // Require a method whenever any balance remains.
    // If already overpaid (e.g. early checkout), no final payment is required.
    const remainingBeforeFinal = +(grandTotal - previouslyPaid - walletCreditApplied).toFixed(2);
    if (remainingBeforeFinal > 0.009) {
      if (!input.paymentMethod) {
        return fail(res, 400, "PAYMENT_REQUIRED", "Payment method is required at check-out");
      }
      if (finalPayment <= 0.009) {
        return fail(res, 400, "PAYMENT_REQUIRED", "Final payment amount is required at check-out");
      }
      if (isUnpaid && (!input.paymentNotes || input.paymentNotes.trim() === "")) {
        return fail(res, 400, "NOTES_REQUIRED", "Notes are required for unpaid checkouts");
      }
    }

    // Pending (unpaid) payments don't actually clear the balance.
    // Wallet credit is treated as already-applied money against the bill.
    const realFinalPaid = isUnpaid ? 0 : finalPayment;
    const collectedSoFar = +(previouslyPaid + realFinalPaid + walletCreditApplied).toFixed(2);
    const overpaidAmount = +(collectedSoFar - grandTotal).toFixed(2);
    const hasOverpaid = overpaidAmount > 0.009;
    if (hasOverpaid && !input.refundMode) {
      return fail(
        res,
        400,
        "REFUND_MODE_REQUIRED",
        `Guest overpaid by ₹${overpaidAmount}. Choose refund mode (cash or credit).`,
      );
    }
    const totalPaid = hasOverpaid ? grandTotal : collectedSoFar;
    const balanceDue = +(grandTotal - totalPaid).toFixed(2);
    const invStatus =
      balanceDue <= 0.009 ? "paid" : totalPaid > 0 ? "partial" : "issued";

    const cgstRate = +(roomGstRate / 2).toFixed(2);
    const sgstRate = +(roomGstRate / 2).toFixed(2);

    let invNumber = "";
    const created = await db.transaction(async (tx) => {
      const invoiceSeq = await nextInvoiceSequence(`SLDT-INV-%`, tx);
      invNumber = invoiceNumber(settings.invoicePrefix, invoiceSeq);
      const [inv] = await tx
        .insert(invoices)
        .values({
          invoiceNumber: invNumber,
          propertyId: r[0]!.propertyId,
          reservationId: id,
          guestId: r[0]!.guestId,
          hotelName: settings.hotelName,
          hotelAddress: settings.hotelAddress,
          hotelGstin: settings.hotelGstin,
          guestName: guest.fullName,
          guestAddress: guest.address ?? null,
          guestGstin: guest.gstin ?? null,
          subtotal: String(subtotal),
          cgstRate: String(cgstRate),
          cgstAmount: String(cgst),
          sgstRate: String(sgstRate),
          sgstAmount: String(sgst),
          grandTotal: String(grandTotal),
          walletCreditApplied: String(walletCreditApplied.toFixed(2)),
          totalPaid: String(totalPaid),
          balanceDue: String(balanceDue),
          status: invStatus,
          // "combined" is only meaningful when it actually rolls up 2+
          // rooms. For a single-room booking that came through this branch
          // (the historical default), tag it as "room" so the UI doesn't
          // show a misleading COMBINED badge on what's really a one-room
          // bill.
          scope: billableRooms.length > 1 ? ("combined" as const) : ("room" as const),
          scopeRoomIds: billableRooms.map((x) => x.room.id),
          issuedBy: req.user!.id,
        })
        .returning();

      await tx
        .insert(invoiceLineItems)
        .values(lineItems.map((li) => ({ invoiceId: inv!.id, ...li })));

      // Link the rooms we just billed to this invoice so they're treated
      // as "invoiced" by any later /:id/invoice scope=room call and the
      // UI's roomInvoiceId field gets populated.
      await tx
        .update(reservationRooms)
        .set({ invoiceId: inv!.id })
        .where(
          and(
            eq(reservationRooms.reservationId, id),
            inArray(
              reservationRooms.roomId,
              billableRooms.map((x) => x.room.id),
            ),
          ),
        );

      await tx
        .update(payments)
        .set({ invoiceId: inv!.id })
        .where(and(eq(payments.reservationId, id), sql`${payments.invoiceId} IS NULL`));

      if (finalPayment > 0 && input.paymentMethod) {
        const rcpNum = await generateReceiptNumber(tx);
        await tx.insert(payments).values({
          receiptNumber: rcpNum,
          propertyId: r[0]!.propertyId,
          invoiceId: inv!.id,
          reservationId: id,
          amount: String(finalPayment),
          paymentMethod: input.paymentMethod,
          status: isUnpaid ? "pending" : "received",
          receivedBy: req.user!.id,
          notes: input.paymentNotes ?? null,
        });
      }

      if (hasOverpaid && input.refundMode === "credit") {
        await tx.insert(guestLedger).values({
          guestId: r[0]!.guestId,
          entryType: "credit_issued",
          amount: String(overpaidAmount.toFixed(2)),
          reservationId: id,
          invoiceId: inv!.id,
          note:
            input.refundNote ??
            `Refund issued as wallet credit on early checkout (reservation ${r[0]!.reservationNumber})`,
          createdBy: req.user!.id,
        });
      }

      // Single source of truth for balanceDue — recompute from facts
      // after all payments + linkages settle. Prevents the historical
      // bug where the combined invoice's balance overwrote the
      // reservation's cross-invoice picture.
      await tx
        .update(reservations)
        .set({
          status: "checked_out",
          checkedOutAt: new Date(),
          checkedOutBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, id));
      await recomputeReservationBalance(tx, id);

      // Only flip rooms that this checkout actually billed. Already-
      // invoiced rooms were vacated by their own per-room checkout and
      // are either already dirty or have moved on to clean/inspected —
      // re-flipping them here would re-trigger housekeeping unnecessarily.
      const checkoutRoomIds = billableRooms.map((x) => x.room.id);
      await tx
        .update(rooms)
        .set({ status: "dirty", updatedAt: new Date() })
        .where(inArray(rooms.id, checkoutRoomIds));

      // Per-room (0017): bulk checkout flips every still-checked-in
      // room on the reservation to checked_out. The roll-up logic in
      // the per-room endpoint then sees "all done" and won't
      // double-process.
      await tx
        .update(reservationRooms)
        .set({
          status: "checked_out",
          checkedOutAt: new Date(),
          checkedOutBy: req.user!.id,
        })
        .where(
          and(
            eq(reservationRooms.reservationId, id),
            inArray(reservationRooms.status, ["confirmed", "checked_in"] as const),
          ),
        );

      return inv!;
    });

    void (async () => {
      try {
        // Complimentary bookings: no checkout notification / WhatsApp.
        if (r[0]!.bookingSource === "complimentary") return;
        const [g] = await db.select().from(guests).where(eq(guests.id, r[0]!.guestId)).limit(1);

        // Generate invoice PDF and upload for public link
        let invoiceLink = "";
        try {
          const [fullInv] = await db
            .select()
            .from(invoices)
            .where(eq(invoices.invoiceNumber, invNumber))
            .limit(1);
          if (fullInv) {
            const [items, pays, settings] = await Promise.all([
              db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, fullInv.id)),
              db.select().from(payments).where(eq(payments.invoiceId, fullInv.id)),
              getSettings(),
            ]);
            const pdf = await renderInvoicePdf({
              invoice: fullInv,
              lineItems: items,
              payments: pays,
              settings,
              stay: {
                checkInDate: r[0]!.checkInDate,
                checkOutDate: r[0]!.checkOutDate,
                numNights: Number(r[0]!.numNights),
                stayType: r[0]!.stayType,
                durationHours: r[0]!.durationHours ? Number(r[0]!.durationHours) : null,
                checkedInAt: r[0]!.checkedInAt
                  ? r[0]!.checkedInAt.toISOString()
                  : null,
                plannedCheckInAt: r[0]!.plannedCheckInAt
                  ? r[0]!.plannedCheckInAt.toISOString()
                  : null,
                plannedCheckOutAt: r[0]!.plannedCheckOutAt
                  ? r[0]!.plannedCheckOutAt.toISOString()
                  : null,
              },
              guestExtra: await loadGuestExtra(r[0]!.id),
            });
            const url = await uploadPublicPdf(`invoices/${invNumber}.pdf`, pdf, documentLabel(g?.fullName ?? fullInv.guestName, g?.phone));
            if (url) invoiceLink = url;
          }
        } catch (err) {
          logger.warn({ err, invoiceNumber: invNumber }, "invoice PDF render/upload failed");
        }

        const settingsCo = await getSettings();
        const baseVars = {
          hotel: env.HOTEL_DISPLAY_NAME,
          hotel_phone: settingsCo.hotelPhone ?? "",
          guest_name: g?.fullName ?? "guest",
          guest_phone: g?.phone ?? "",
          guest_email: g?.email ?? "",
          reservation_number: r[0]!.reservationNumber,
          check_out_date: r[0]!.checkOutDate,
          invoice_number: invNumber,
          invoice_link: invoiceLink,
          total: r[0]!.grandTotal,
        };

        const checkedOutRooms = await getReservationRoomNumbers(id);
        const coRoomSuffix = checkedOutRooms ? ` · Room ${checkedOutRooms}` : "";
        await dispatchNotification({
          type: "guest_checked_out",
          title: "Guest checked out",
          body: `${g?.fullName ?? "Guest"} (${r[0]!.reservationNumber}${coRoomSuffix}). Invoice ${invNumber}.`,
          href: `/reservations/${id}`,
          payload: { reservationId: id, invoiceNumber: invNumber, invoiceLink },
          recipientRoles: ["admin", "frontdesk", "housekeeping"],
        });
        if (g?.phone) {
          const t = await renderTemplate("checkout_guest_sms", baseVars);
          if (t.enabled) await notifyGuestSms({ to: g.phone, text: t.body });
        }
        const ownerT = await renderTemplate("checkout_owner_sms", baseVars);
        if (ownerT.enabled) await notifyOwner(ownerT.body);

        // Phase 5 — review automation. We schedule a follow-up review
        // prompt 4 hours after checkout (long enough for the guest to
        // have gotten home + settled in, short enough to be on the same
        // day they remember the stay). The link points to GOOGLE_REVIEW_URL
        // if set; otherwise we send the bare prompt.
        //
        // NOTE: this uses setTimeout, which is in-process and lost on
        // restart. For a busier property, swap for a job queue.
        if (g?.phone) {
          const reviewLink = (env.GOOGLE_REVIEW_URL ?? "").trim();
          const reviewVars = {
            ...baseVars,
            review_link: reviewLink,
          };
          const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
          setTimeout(() => {
            void (async () => {
              try {
                const t = await renderTemplate("review_prompt_guest_sms", reviewVars);
                if (t.enabled && g.phone) {
                  await notifyGuestSms({ to: g.phone, text: t.body });
                }
              } catch (e) {
                logger.warn(
                  { err: e, reservationId: id },
                  "review-prompt send failed",
                );
              }
            })();
          }, FOUR_HOURS_MS).unref();
        }
      } catch (err) {
        logger.warn({ err, reservationId: id }, "post-check-out notification failed");
      }
    })();

    await logActivity({
      action: "check_out",
      entityType: "reservation",
      entityId: id,
      description: `${r[0]!.reservationNumber} checked out, invoice ${invNumber}${hasOverpaid ? ` (refund ₹${overpaidAmount} as ${input.refundMode})` : ""}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        invoiceId: created.id,
        finalPayment,
        overpaidAmount: hasOverpaid ? overpaidAmount : 0,
        refundMode: hasOverpaid ? input.refundMode : null,
      },
    });
    await invalidateDashboard();
    return ok(res, { invoice: created });
  },
);

// Reclassify an existing booking as complimentary AFTER it was created.
// Pure accounting reclassification — nothing destructive. The invoice
// (if any) and all payments stay exactly as they are.
//
// The product rule is: a complimentary booking is REMOVED from every
// "real revenue" surface (Dashboard revenue, Revenue report, GST report,
// Collections, Room Performance, main Reservations list) and APPEARS
// ONLY in the Complimentary report. The booking row itself is kept so
// the URL still resolves and the guest's stay history still shows the
// stay happened.
//
// Implementation: filter out `bookingSource = 'complimentary'` in every
// revenue query. The comp report is the single place that includes them.
//
// Works on confirmed / checked_in / checked_out. Blocked on cancelled
// and already-complimentary.
router.post(
  "/:id/make-complimentary",
  requireAuth,
  requirePermission("view_reservations"),
  validate(makeComplimentarySchema),
  async (req, res) => {
    const id = req.params.id!;
    const { reason, approver } = req.body as { reason: string; approver?: string | null };

    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    const current = r[0]!;

    if (!["confirmed", "checked_in", "checked_out"].includes(current.status)) {
      return fail(
        res,
        409,
        "INVALID_STATUS",
        `Cannot reclassify a ${current.status} reservation as complimentary.`,
      );
    }

    if (current.bookingSource === "complimentary") {
      return fail(res, 409, "ALREADY_COMPLIMENTARY", "This booking is already complimentary.");
    }

    // Compose the audit trail string we store on creditNotes. Pairs the
    // human reason with the approver name when given, plus the prior
    // bookingSource + status so we can tell at a glance the prior state
    // ("was walkin / checked_out — comped on <date>").
    const stamp = new Date().toISOString();
    const previousSource = current.bookingSource;
    const composedNote = [
      `Comped on ${stamp} (was ${previousSource}, status ${current.status})`,
      approver?.trim() ? `Approved by: ${approver.trim()}` : null,
      `Reason: ${reason.trim()}`,
      current.creditNotes ? `Prior notes: ${current.creditNotes}` : null,
    ]
      .filter(Boolean)
      .join(" — ");

    // Pure reclassification — no invoice or payment changes. Every revenue
    // query filters on bookingSource so this booking will silently fall
    // out of Dashboard / Revenue / GST / Collections / Room Performance,
    // and the Complimentary report (which filters the other direction)
    // will pick it up.
    await db
      .update(reservations)
      .set({
        bookingSource: "complimentary",
        creditNotes: composedNote,
        updatedAt: new Date(),
      })
      .where(eq(reservations.id, id));

    // Wipe any in-app notifications this booking already generated
    // BEFORE it was comped (new booking / check-in / check-out alerts).
    // The reservation id lives in the notification's JSONB payload.
    // Going comp means going silent retroactively too.
    await db
      .delete(notifications)
      .where(sql`${notifications.payload}->>'reservationId' = ${id}`);

    await logActivity({
      action: "reservation_made_complimentary",
      entityType: "reservation",
      entityId: id,
      description: `${current.reservationNumber} reclassified as complimentary (was ${previousSource})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        previousSource,
        previousStatus: current.status,
        reason: reason.trim(),
        approver: approver?.trim() || null,
        grandTotal: current.grandTotal,
      },
    });
    await invalidateDashboard();

    const [updated] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    return ok(res, updated);
  },
);

router.post(
  "/:id/cancel",
  requireAuth,
  requirePermission("view_reservations"),
  validate(cancelSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as {
      cancellationReason: string;
      refundMode?: "cash" | "credit";
      cancellationFee?: number;
    };
    const cancellationReason = input.cancellationReason;
    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (!["confirmed", "checked_in"].includes(r[0]!.status)) {
      return fail(res, 409, "INVALID_STATUS", `Cannot cancel ${r[0]!.status}`);
    }

    const roomIds = (
      await db
        .select({ roomId: reservationRooms.roomId })
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, id))
    ).map((x) => x.roomId);

    // Room target status after cancel: a confirmed (not-yet-arrived) booking
    // frees the room outright; a checked_in booking leaves the room dirty
    // because the guest physically used it.
    const wasCheckedIn = r[0]!.status === "checked_in";
    const targetRoomStatus = wasCheckedIn ? "dirty" : "available";

    // Money math. The advance the guest paid is currently sitting on
    // payments rows (received, not voided) and rolled up onto the
    // reservation's advance_paid column. We respect the fee first:
    // keep `cancellationFee` of the advance as revenue, refund / credit
    // the remainder. If there's no advance at all, both refundable and
    // fee collapse to 0 and the fee/mode fields are ignored.
    const advancePaid = Number(r[0]!.advancePaid ?? 0);
    const requestedFee = Math.max(0, Number(input.cancellationFee ?? 0));
    const cancellationFee = Math.min(requestedFee, advancePaid);
    const refundable = +(advancePaid - cancellationFee).toFixed(2);
    // Refund destination: defaults to cash when omitted (matches
    // legacy callers). "credit" goes to the wallet ledger; everything
    // else records a negative payment row whose paymentMethod matches
    // the chosen channel (cash/upi/card/bank_transfer) so revenue
    // reports break refunds down by channel correctly.
    const refundMode: "cash" | "upi" | "card" | "bank_transfer" | "credit" =
      input.refundMode ?? "cash";
    const walletCreditRestored = Number(r[0]!.walletCreditApplied ?? 0);

    let refundedCash = 0;
    let creditIssued = 0;
    const voidedPaymentCount = 0;
    const voidedPaymentTotal = 0;

    await db.transaction(async (tx) => {
      // 1. Resolve the advance per the chosen mode.
      //
      // refundMode = "cash":
      //   - Keep the original payment rows intact (they actually
      //     happened — cash was collected). Insert ONE negative
      //     refund payment row tied to the reservation so the ledger
      //     reads "+₹X advance" then "-₹Y refund". Cancellation fee
      //     stays as positive revenue on the reservation.
      //
      // refundMode = "credit":
      //   - Same as cash for the payment rows (they happened), but
      //     instead of a negative refund row we move the refundable
      //     amount into the guest's wallet via guest_ledger.
      //
      // Legacy void path: when no fee + no mode is specified, behave
      // like the old endpoint (void every payment) so existing
      // automated callers don't see new ledger noise.
      if (advancePaid <= 0.009) {
        // Nothing collected from the guest. Still void any zero-value
        // booking-receipt rows for cleanliness.
        const livePays = await tx
          .select()
          .from(payments)
          .where(and(eq(payments.reservationId, id), eq(payments.voided, false)));
        for (const p of livePays) {
          await tx
            .update(payments)
            .set({
              voided: true,
              voidedReason: `Reservation cancelled: ${cancellationReason}`,
              voidedBy: req.user!.id,
              voidedAt: new Date(),
            })
            .where(eq(payments.id, p.id));
        }
      } else if (refundMode === "credit") {
        // Move refundable amount to wallet credit. Original receipts
        // stay live so the reservation's payment history is honest.
        if (refundable > 0.009) {
          await lockKey(tx, `guest-wallet:${r[0]!.guestId}`);
          await tx.insert(guestLedger).values({
            guestId: r[0]!.guestId,
            entryType: "credit_issued",
            amount: String(refundable.toFixed(2)),
            reservationId: id,
            note:
              `Refund as credit: cancelled reservation ${r[0]!.reservationNumber}` +
              (cancellationFee > 0.009 ? ` (fee ₹${cancellationFee.toFixed(2)} withheld)` : ""),
            createdBy: req.user!.id,
          });
          creditIssued = refundable;
        }
      } else {
        // Cash/UPI/card/bank_transfer — record a negative refund
        // payment row tagged with the chosen channel so reports can
        // break refund channels down correctly.
        if (refundable > 0.009) {
          const rcpNum = await generateReceiptNumber(tx);
          await tx.insert(payments).values({
            receiptNumber: rcpNum,
            propertyId: r[0]!.propertyId,
            reservationId: id,
            amount: String((-refundable).toFixed(2)),
            paymentMethod: refundMode,
            status: "received",
            receivedBy: req.user!.id,
            notes:
              `Refund: cancelled reservation ${r[0]!.reservationNumber}` +
              (cancellationFee > 0.009 ? ` (fee ₹${cancellationFee.toFixed(2)} withheld)` : ""),
          });
          refundedCash = refundable;
        }
      }

      // 2. If the guest had wallet credit applied (separate from cash
      //    advance), return it to their wallet regardless of refundMode —
      //    that money never belonged to this reservation in the first
      //    place. We don't apply the cancellation fee against this; the
      //    fee is a charge against the guest's cash advance only.
      if (walletCreditRestored > 0.009) {
        await lockKey(tx, `guest-wallet:${r[0]!.guestId}`);
        await tx.insert(guestLedger).values({
          guestId: r[0]!.guestId,
          entryType: "credit_issued",
          amount: String(walletCreditRestored.toFixed(2)),
          reservationId: id,
          note: `Wallet credit returned: cancelled reservation ${r[0]!.reservationNumber}`,
          createdBy: req.user!.id,
        });
      }

      // 3. If a cancellation fee was withheld, record it as a charge
      //    against the reservation so the cash actually collected
      //    matches the reservation's grand_total recompute. The fee
      //    surfaces as revenue on cancellation reports.
      if (cancellationFee > 0.009) {
        await tx.insert(additionalCharges).values({
          reservationId: id,
          description: `Cancellation fee — ${cancellationReason}`,
          quantity: 1,
          rate: String(cancellationFee.toFixed(2)),
          amount: String(cancellationFee.toFixed(2)),
          gstRate: "0",
          addedBy: req.user!.id,
        });
      }

      // 4. Update the reservation row. grand_total is set to the
      //    cancellation fee (anything else is revenue-not-realised).
      //    advance_paid + balance_due will be recomputed from facts.
      await tx
        .update(reservations)
        .set({
          status: "cancelled",
          cancellationReason,
          grandTotal: String(cancellationFee.toFixed(2)),
          subtotal: String(cancellationFee.toFixed(2)),
          gstAmount: "0",
          walletCreditApplied: "0",
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, id));

      // 4. Free / dirty the rooms.
      if (roomIds.length) {
        await tx
          .update(rooms)
          .set({ status: targetRoomStatus, updatedAt: new Date() })
          .where(inArray(rooms.id, roomIds));
      }

      // Per-room (0017): mirror the cancellation onto every
      // reservation_room row so per-room queries are accurate.
      await tx
        .update(reservationRooms)
        .set({ status: "cancelled" })
        .where(eq(reservationRooms.reservationId, id));

      // Recompute advance_paid + balance_due from the now-final
      // payment rows. For cash refunds the negative row brings the
      // ledger to ₹0; for credit refunds the originals stay positive
      // and the wallet ledger absorbs the offset; either way the
      // reservation's running balance reflects what the property
      // actually still owes the guest (or vice versa).
      await recomputeReservationBalance(tx, id);
    });

    const descBits = [
      `${r[0]!.reservationNumber} cancelled: ${cancellationReason}`,
    ];
    if (cancellationFee > 0.009) {
      descBits.push(`fee ₹${cancellationFee.toFixed(2)} withheld`);
    }
    if (refundedCash > 0.009) {
      descBits.push(
        `₹${refundedCash.toFixed(2)} refunded via ${refundMode.replace(/_/g, " ")}`,
      );
    }
    if (creditIssued > 0.009) {
      descBits.push(`₹${creditIssued.toFixed(2)} issued as wallet credit`);
    }
    if (walletCreditRestored > 0.009) {
      descBits.push(`₹${walletCreditRestored.toFixed(2)} wallet credit returned`);
    }
    if (voidedPaymentCount > 0) {
      descBits.push(`${voidedPaymentCount} payment(s) voided`);
    }
    await logActivity({
      action: "reservation_cancelled",
      entityType: "reservation",
      entityId: id,
      description: descBits.join(" · "),
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        cancellationFee,
        refundedCash,
        creditIssued,
        walletCreditRestored,
        voidedPaymentCount,
        voidedPaymentTotal,
        roomStatus: targetRoomStatus,
        refundMode,
      },
    });
    // Complimentary bookings stay silent — no cancellation notification.
    if (r[0]!.bookingSource !== "complimentary") {
      try {
        const cancelledRooms = await getReservationRoomNumbers(id);
        const [cancelGuest] = await db
          .select({ fullName: guests.fullName })
          .from(guests)
          .where(eq(guests.id, r[0]!.guestId))
          .limit(1);
        const moneyBits = descBits.slice(1);
        await dispatchNotification({
          type: "reservation_cancelled",
          title: "Reservation cancelled",
          body: `${r[0]!.reservationNumber} · ${cancelGuest?.fullName ?? "Guest"}${cancelledRooms ? ` · Room ${cancelledRooms}` : ""} — ${cancellationReason}${moneyBits.length ? ` · ${moneyBits.join(" · ")}` : ""}`,
          href: `/reservations/${id}`,
          payload: { reservationId: id },
          recipientRoles: ["admin", "frontdesk", "housekeeping"],
        });
      } catch (err) {
        logger.warn({ err, reservationId: id }, "cancel notification failed");
      }
    }
    await invalidateDashboard();
    return ok(res, {
      success: true,
      cancellationFee,
      refundedCash,
      creditIssued,
      walletCreditRestored,
      voidedPaymentCount,
      voidedPaymentTotal,
      refundMode,
      roomStatus: targetRoomStatus,
    });
  },
);

// Mark a confirmed reservation as no-show. Standard hotel policy:
// the advance (if any) is FORFEIT — it stays on the books as revenue
// and is not refunded. Rooms are released immediately (the guest
// never arrived → no cleaning needed). Only valid on 'confirmed'
// status; a checked_in guest by definition arrived, so they can't be
// a no-show. Use Cancel for those.
router.post(
  "/:id/no-show",
  requireAuth,
  requirePermission("view_reservations"),
  validate(noShowSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { note } = req.body as { note: string };
    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (r[0]!.status !== "confirmed") {
      return fail(
        res,
        409,
        "INVALID_STATUS",
        `Only confirmed reservations can be marked no-show (current: ${r[0]!.status})`,
      );
    }

    const roomIds = (
      await db
        .select({ roomId: reservationRooms.roomId })
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, id))
    ).map((x) => x.roomId);

    const forfeitedAdvance = Number(r[0]!.advancePaid ?? 0);

    await db.transaction(async (tx) => {
      // Reservation: flip to no_show. The advance stays on the books
      // (forfeit revenue). The balance is set to 0 — there's nothing
      // more to collect because the stay isn't happening.
      // cancellationReason field doubles as the no-show note so the
      // existing reports + audit surfaces pick it up without a schema
      // change.
      await tx
        .update(reservations)
        .set({
          status: "no_show",
          cancellationReason: note,
          balanceDue: "0",
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, id));

      // Free the rooms. Guest never arrived → status goes straight to
      // 'available' (no dirty/cleaning step).
      if (roomIds.length) {
        await tx
          .update(rooms)
          .set({ status: "available", updatedAt: new Date() })
          .where(inArray(rooms.id, roomIds));
      }

      // Mirror onto per-room rows so per-room queries see no_show.
      // We reuse 'cancelled' on the row enum because reservation_rooms
      // doesn't have a no_show state — the parent's status is the
      // canonical truth.
      await tx
        .update(reservationRooms)
        .set({ status: "cancelled" })
        .where(eq(reservationRooms.reservationId, id));
    });

    await logActivity({
      action: "reservation_no_show",
      entityType: "reservation",
      entityId: id,
      description: `${r[0]!.reservationNumber} marked no-show: ${note}${
        forfeitedAdvance > 0 ? ` · ₹${forfeitedAdvance.toFixed(2)} advance forfeited` : ""
      }`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { forfeitedAdvance, note },
    });
    // No-show releases rooms exactly like a cancellation — reuse the
    // cancelled notification type (red badge); the title disambiguates.
    // Complimentary bookings stay silent.
    if (r[0]!.bookingSource !== "complimentary") {
      try {
        const nsRooms = await getReservationRoomNumbers(id);
        const [nsGuest] = await db
          .select({ fullName: guests.fullName })
          .from(guests)
          .where(eq(guests.id, r[0]!.guestId))
          .limit(1);
        await dispatchNotification({
          type: "reservation_cancelled",
          title: "No-show",
          body: `${r[0]!.reservationNumber} · ${nsGuest?.fullName ?? "Guest"}${nsRooms ? ` · Room ${nsRooms}` : ""} — ${note}${forfeitedAdvance > 0 ? ` · ₹${forfeitedAdvance.toFixed(2)} advance forfeited` : ""}`,
          href: `/reservations/${id}`,
          payload: { reservationId: id },
          recipientRoles: ["admin", "frontdesk", "housekeeping"],
        });
      } catch (err) {
        logger.warn({ err, reservationId: id }, "no-show notification failed");
      }
    }
    await invalidateDashboard();
    return ok(res, { success: true, forfeitedAdvance });
  },
);

router.post(
  "/:id/swap-room",
  requireAuth,
  requirePermission("view_reservations"),
  validate(swapRoomSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { newRoomId } = req.body as { newRoomId: string };

    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (!["confirmed", "checked_in"].includes(r[0]!.status)) {
      return fail(res, 409, "INVALID_STATUS", `Cannot swap room on ${r[0]!.status}`);
    }

    // For short_stay (day-use), checkInDate == checkOutDate would collapse
    // to an empty Postgres daterange and silently pass the availability
    // check. Widen the probe to [d, d+1) so the lib's short_stay branch
    // fires (mirrors the same widening used in availability.ts).
    const probeOut =
      r[0]!.stayType === "short_stay"
        ? new Date(new Date(r[0]!.checkInDate).getTime() + 86400000)
            .toISOString()
            .slice(0, 10)
        : r[0]!.checkOutDate;
    const available = await isRoomAvailable(newRoomId, r[0]!.checkInDate, probeOut, id);
    if (!available) return fail(res, 409, "ROOM_UNAVAILABLE", "New room is not available");

    const oldRows = await db
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, id));
    if (!oldRows.length) return fail(res, 400, "NO_ROOMS", "Reservation has no rooms");
    const oldRoomId = oldRows[0]!.roomId;

    await db.transaction(async (tx) => {
      await tx
        .update(reservationRooms)
        .set({ roomId: newRoomId })
        .where(eq(reservationRooms.id, oldRows[0]!.id));
      await tx
        .update(rooms)
        .set({
          status: r[0]!.status === "checked_in" ? "dirty" : "available",
          updatedAt: new Date(),
        })
        .where(eq(rooms.id, oldRoomId));
      await tx
        .update(rooms)
        .set({
          status: r[0]!.status === "checked_in" ? "occupied" : "reserved",
          updatedAt: new Date(),
        })
        .where(eq(rooms.id, newRoomId));
    });

    await logActivity({
      action: "room_swap",
      entityType: "reservation",
      entityId: id,
      description: `${r[0]!.reservationNumber}: room swapped`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { oldRoomId, newRoomId },
    });
    await invalidateDashboard();
    return ok(res, { success: true });
  },
);

// Mid-stay room swap. Closes the current reservation_rooms row at the
// effective date and inserts a new row pointing at the new room for the
// remainder of the stay. Charges, GST, advance, invoice — none of it
// moves. Both rows share a swap_id so reports can show them as one
// event ("Guest moved 201 → 305 on 01 Jun"). The vacated room's
// status is set to `markOldRoomStatus` (defaults to maintenance).
router.post(
  "/:id/swap-room-segment",
  requireAuth,
  requirePermission("view_reservations"),
  idempotent("reservations.swapRoomSegment"),
  validate(swapRoomSegmentSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as z.infer<typeof swapRoomSegmentSchema>;

    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    const reservation = r[0]!;
    if (reservation.status !== "checked_in") {
      return fail(
        res,
        409,
        "INVALID_STATUS",
        `Room swap is only valid for a checked-in reservation (status: ${reservation.status})`,
      );
    }

    const segs = await db
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.id, input.fromReservationRoomId));
    if (!segs.length || segs[0]!.reservationId !== id) {
      return fail(res, 404, "SEGMENT_NOT_FOUND", "Source room segment not found on this reservation");
    }
    const seg = segs[0]!;
    if (seg.status !== "checked_in") {
      return fail(
        res,
        409,
        "ROOM_NOT_CHECKED_IN",
        `That room slot is ${seg.status}, can't swap`,
      );
    }
    if (seg.invoiceId) {
      return fail(
        res,
        409,
        "ROOM_INVOICED",
        "That room is already invoiced — issue a credit note instead of swapping",
      );
    }
    if (seg.roomId === input.toRoomId) {
      return fail(res, 400, "SAME_ROOM", "Target room is the same as the current room");
    }

    // When the old room is being sent to maintenance, demand a real
    // issue payload so the room ends up on the Maintenance page (and
    // the property doesn't lose track of why it was sidelined).
    if (input.markOldRoomStatus === "maintenance" && !input.maintenanceIssue) {
      return fail(
        res,
        400,
        "MAINTENANCE_ISSUE_REQUIRED",
        "Marking the old room as maintenance requires issue details (category, title, description, cost).",
      );
    }

    const swapId = randomUUID();
    const now = new Date();
    const isShortStay = reservation.stayType === "short_stay";
    // In-place swap (no segmentation):
    //   - day-use bookings (one calendar day, nothing to split)
    //   - overnight bookings where the caller omitted effectiveDate.
    //     This covers 1-night stays where there's no meaningful
    //     sub-range; the UI also uses this for any "swap immediately,
    //     don't bother splitting" case.
    const inPlace = isShortStay || !input.effectiveDate;

    if (inPlace) {
      // Re-point the row at the new room and rotate housekeeping status.
      // Charges, rate, GST, duration — all untouched.
      const probeIn = reservation.checkInDate;
      const probeOut = isShortStay
        ? // short_stay availability probes [d, d+1) — the +1 day matches
          // the lib's single-day branch.
          new Date(new Date(probeIn).getTime() + 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10)
        : reservation.checkOutDate;
      const available = await isRoomAvailable(
        input.toRoomId,
        probeIn,
        probeOut,
        id,
      );
      if (!available) {
        return fail(res, 409, "ROOM_UNAVAILABLE", "Target room is not available for this stay");
      }

      // Optional rate override: when swapping to a different room
      // category, the staff can change the per-night rate. We apply
      // the new rate to this re-pointed row and recompute the
      // reservation's subtotal/GST/grand_total/balance from facts so
      // the bill reflects what the guest will actually pay.
      const oldRate = Number(seg.ratePerNight);
      const hasRateChange =
        input.newRate !== undefined &&
        Math.abs(input.newRate - oldRate) > 0.009;
      const newRate = hasRateChange ? input.newRate! : oldRate;

      await db.transaction(async (tx) => {
        // 0037 — record this hop before we overwrite the row, so a
        // chain of in-place swaps (202 -> 201 -> 301) leaves a full
        // ladder behind. Snapshot the rate that *was* on the row
        // (oldRate) — that's what the closed leg's rate was.
        await tx.insert(reservationRoomSwapHistory).values({
          reservationRoomId: seg.id,
          fromRoomId: seg.roomId,
          toRoomId: input.toRoomId,
          reason: input.reason,
          ratePerNight: String(oldRate),
          createdBy: req.user!.id,
        });

        await tx
          .update(reservationRooms)
          .set({
            roomId: input.toRoomId,
            swapId,
            swapReason: input.reason,
            // 0036 — preserve the prior room so the UI can render
            // "Swapped from Room 203". Without this, an in-place swap
            // silently overwrites the source room number.
            swappedFromRoomId: seg.roomId,
            ratePerNight: String(newRate),
          })
          .where(eq(reservationRooms.id, seg.id));
        await tx
          .update(rooms)
          .set({ status: input.markOldRoomStatus, updatedAt: now })
          .where(eq(rooms.id, seg.roomId));
        await tx
          .update(rooms)
          .set({ status: "occupied", updatedAt: now })
          .where(eq(rooms.id, input.toRoomId));

        // File the maintenance issue for the vacated room so it shows up
        // on the Maintenance page. The schema validation above guarantees
        // payload presence whenever markOldRoomStatus = "maintenance".
        if (input.markOldRoomStatus === "maintenance" && input.maintenanceIssue) {
          const mi = input.maintenanceIssue;
          await tx.insert(maintenanceIssues).values({
            roomId: seg.roomId,
            category: mi.category,
            severity: mi.severity,
            title: mi.title.trim(),
            description: mi.description.trim(),
            costEstimate: String(Number(mi.costEstimate).toFixed(2)),
            reportedBy: req.user!.id,
            reportedAt: now,
          });
        }

        if (hasRateChange) {
          // Recompute reservation totals from the new per-row rate.
          // For in-place swaps the swap covers the full segment, so
          // the delta in subtotal is (newRate - oldRate) * segNights.
          const segNights = isShortStay
            ? 1
            : Math.max(
                1,
                Math.round(
                  (new Date(reservation.checkOutDate).getTime() -
                    new Date(reservation.checkInDate).getTime()) /
                    (24 * 60 * 60 * 1000),
                ),
              );
          const delta = +((newRate - oldRate) * segNights).toFixed(2);
          const gstMode = reservation.gstMode ?? "exclusive";
          const gstRate = Number(reservation.gstRate);
          // In exclusive mode the stored subtotal is net (pre-GST);
          // shift it by the delta, then recompute GST + grand total
          // through the same helper so rounding matches every other
          // path. In inclusive mode the delta arrives gross; bump
          // grand total instead and let the breakdown extract net.
          const combinedAmount =
            gstMode === "inclusive"
              ? +(Number(reservation.grandTotal) + delta).toFixed(2)
              : +(Number(reservation.subtotal) + delta).toFixed(2);
          const { subtotal, gstAmount, grandTotal } = calcGstBreakdown(
            combinedAmount,
            gstRate,
            gstMode,
          );
          await tx
            .update(reservations)
            .set({
              subtotal: String(subtotal),
              gstAmount: String(gstAmount),
              grandTotal: String(grandTotal),
              updatedAt: now,
            })
            .where(eq(reservations.id, id));
          // balanceDue follows grandTotal — recompute from facts.
          await recomputeReservationBalance(tx, id);
        }
      });
    } else {
      // Overnight + caller provided effectiveDate → segment the row.
      // The `inPlace` guard above already returned `effectiveDate`
      // present, so the non-null assertion is sound.
      const effectiveDate = input.effectiveDate!;
      const segFrom = seg.effectiveFrom ?? reservation.checkInDate;
      const segTo = seg.effectiveTo ?? reservation.checkOutDate;
      // Effective date must fall strictly inside the current segment —
      // not on either boundary (a swap on the check-in date is just an
      // edit; a swap on the check-out date is a no-op).
      if (effectiveDate <= segFrom || effectiveDate >= segTo) {
        return fail(
          res,
          400,
          "EFFECTIVE_OUT_OF_RANGE",
          `Effective date must be between ${segFrom} and ${segTo} (exclusive)`,
        );
      }

      // The new room must be free for [effectiveDate, segTo).
      const available = await isRoomAvailable(
        input.toRoomId,
        effectiveDate,
        segTo,
        id,
      );
      if (!available) {
        return fail(res, 409, "ROOM_UNAVAILABLE", "Target room is not available for the remainder of the stay");
      }

      // Optional rate override for the remainder of the stay. Only
      // the new segment uses the new rate; the closed leg keeps the
      // original rate. If the rate changed, recompute reservation
      // totals from the per-row deltas (new rate × remaining nights).
      const oldRate = Number(seg.ratePerNight);
      const hasRateChange =
        input.newRate !== undefined &&
        Math.abs(input.newRate - oldRate) > 0.009;
      const newSegRate = hasRateChange ? input.newRate! : oldRate;

      await db.transaction(async (tx) => {
        // 1. Close the old segment at the swap date.
        await tx
          .update(reservationRooms)
          .set({
            effectiveFrom: segFrom,
            effectiveTo: effectiveDate,
            swapId,
            swapReason: input.reason,
          })
          .where(eq(reservationRooms.id, seg.id));

        // 2. Insert a new segment for the remainder of the stay.
        // Rate may differ if staff chose to renegotiate at swap time.
        await tx.insert(reservationRooms).values({
          reservationId: id,
          roomId: input.toRoomId,
          ratePerNight: String(newSegRate),
          soldAsType: seg.soldAsType,
          guestId: seg.guestId,
          status: "checked_in",
          checkedInAt: now,
          checkedInBy: req.user!.id,
          invoiceId: seg.invoiceId,
          effectiveFrom: effectiveDate,
          effectiveTo: segTo,
          swapId,
          swapReason: input.reason,
        });

        // 3. Vacated room → markOldRoomStatus (defaults to maintenance).
        await tx
          .update(rooms)
          .set({ status: input.markOldRoomStatus, updatedAt: now })
          .where(eq(rooms.id, seg.roomId));

        // 4. New room → occupied.
        await tx
          .update(rooms)
          .set({ status: "occupied", updatedAt: now })
          .where(eq(rooms.id, input.toRoomId));

        // 5. File a maintenance issue for the vacated room. Same
        // behaviour as the in-place branch — keeps both paths in sync.
        if (input.markOldRoomStatus === "maintenance" && input.maintenanceIssue) {
          const mi = input.maintenanceIssue;
          await tx.insert(maintenanceIssues).values({
            roomId: seg.roomId,
            category: mi.category,
            severity: mi.severity,
            title: mi.title.trim(),
            description: mi.description.trim(),
            costEstimate: String(Number(mi.costEstimate).toFixed(2)),
            reportedBy: req.user!.id,
            reportedAt: now,
          });
        }

        if (hasRateChange) {
          // Segmented path: the rate applies only to the remainder of
          // the stay (effectiveDate -> segTo), not the whole segment.
          const remainingNights = Math.max(
            1,
            Math.round(
              (new Date(segTo).getTime() - new Date(effectiveDate).getTime()) /
                (24 * 60 * 60 * 1000),
            ),
          );
          const delta = +(
            (newSegRate - oldRate) * remainingNights
          ).toFixed(2);
          const gstMode = reservation.gstMode ?? "exclusive";
          const gstRate = Number(reservation.gstRate);
          const combinedAmount =
            gstMode === "inclusive"
              ? +(Number(reservation.grandTotal) + delta).toFixed(2)
              : +(Number(reservation.subtotal) + delta).toFixed(2);
          const { subtotal, gstAmount, grandTotal } = calcGstBreakdown(
            combinedAmount,
            gstRate,
            gstMode,
          );
          await tx
            .update(reservations)
            .set({
              subtotal: String(subtotal),
              gstAmount: String(gstAmount),
              grandTotal: String(grandTotal),
              updatedAt: now,
            })
            .where(eq(reservations.id, id));
          await recomputeReservationBalance(tx, id);
        }
      });
    }

    await logActivity({
      action: "room_swap_segment",
      entityType: "reservation",
      entityId: id,
      description: `${reservation.reservationNumber}: room swapped on ${input.effectiveDate} (${input.reason})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        swapId,
        fromRoomId: seg.roomId,
        toRoomId: input.toRoomId,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        markOldRoomStatus: input.markOldRoomStatus,
      },
    });
    await invalidateDashboard();
    return ok(res, { success: true, swapId });
  },
);

router.post(
  "/:id/charges",
  requireAuth,
  requirePermission("view_reservations"),
  idempotent("reservations.addCharge"),
  validate(additionalChargeSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as import("@stayvia/shared").AdditionalChargeInput;
    const amount = +(input.quantity * input.rate).toFixed(2);
    const [created] = await db
      .insert(additionalCharges)
      .values({
        reservationId: id,
        // Migration 0018 — optional per-room attribution.
        roomId: input.roomId ?? null,
        description: input.description,
        quantity: input.quantity,
        rate: String(input.rate),
        amount: String(amount),
        gstRate: String(input.gstRate),
        addedBy: req.user!.id,
      })
      .returning();

    await recalcReservation(id);
    await logActivity({
      action: "charge_added",
      entityType: "reservation",
      entityId: id,
      description: `Charge: ${input.description} ₹${amount}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    await invalidateDashboard();
    return ok(res, created, 201);
  },
);

router.post(
  "/:id/extend",
  requireAuth,
  requirePermission("view_reservations"),
  validate(extendReservationSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as { newCheckOutDate: string; ratePerNight?: number };

    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r[0]) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    const current = r[0];
    if (current.status !== "confirmed" && current.status !== "checked_in") {
      return fail(res, 400, "INVALID_STATE", "Only confirmed or checked-in reservations can be extended");
    }
    if (current.stayType === "short_stay") {
      return fail(
        res,
        400,
        "SHORT_STAY_NOT_EXTENDABLE",
        "Short-stay (day-use) bookings can't be extended. Create a new reservation instead.",
      );
    }
    if (new Date(input.newCheckOutDate) <= new Date(current.checkOutDate)) {
      return fail(res, 400, "INVALID_DATES", "New check-out must be after current check-out");
    }

    const assigned = await db
      .select({ roomId: reservationRooms.roomId, ratePerNight: reservationRooms.ratePerNight })
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, id));

    for (const rm of assigned) {
      const ok = await isRoomAvailable(rm.roomId, current.checkOutDate, input.newCheckOutDate, id);
      if (!ok) {
        return fail(res, 409, "ROOM_UNAVAILABLE", "Room is not available for the extended period", {
          roomId: rm.roomId,
        });
      }
    }

    // Number of NEW nights being added (the extension window only).
    const extraNights = differenceInCalendarDays(
      new Date(input.newCheckOutDate),
      new Date(current.checkOutDate),
    );

    // Pricing model for the extension:
    //   - The existing nights keep their rate. We do NOT touch
    //     reservation_rooms.ratePerNight, so recalcReservation continues
    //     to bill the room at its original rate for ALL nights (including
    //     the new ones at the original rate).
    //   - If the staff agreed a DIFFERENT rate for the new night(s), we
    //     don't re-rate the whole stay. Instead we add a single
    //     "Stay extension" additional_charge for the DELTA only:
    //         extraNights × (newRate − roomRate) × roomCount
    //     Added to the room line (original rate × all nights), this
    //     yields exactly: oldNights×oldRate + newNights×newRate.
    //   - If no rate (or the same rate) is given, the new nights simply
    //     bill at the existing room rate and no extra charge is created.
    //
    // The delta charge is taxed at the same GST slab as the room so the
    // extra night is treated consistently with the rest of the stay.
    //
    // GST MODE: the extension must honour the reservation's GST mode so
    // it matches the rest of the bill.
    //   - exclusive: the agreed per-night rate is NET. The delta is net
    //     and we store it as-is; recalcReservation adds GST on top.
    //   - inclusive: the agreed per-night rate is GROSS (all-in). The
    //     guest expects ₹2,000/night to mean ₹2,000 including tax, same
    //     as the room nights. But recalcReservation always treats a
    //     charge's stored `amount` as NET and re-adds GST on top. So we
    //     extract the NET portion from the gross delta here, store that;
    //     recalc then adds the GST back → the line totals to the gross
    //     the guest agreed to. Net result: identical tax treatment to
    //     the inclusive-mode room nights.
    const reservationGstMode = current.gstMode ?? "exclusive";
    let extensionChargeId: string | null = null;
    if (input.ratePerNight && assigned.length > 0) {
      // Per-room delta vs each room's own rate (rooms can differ). This
      // delta is in the SAME mode as the rates (gross if inclusive, net
      // if exclusive) because both sides of the subtraction are in that
      // mode.
      let deltaAmount = 0;
      for (const rm of assigned) {
        const delta = (input.ratePerNight - Number(rm.ratePerNight)) * extraNights;
        deltaAmount += delta;
      }
      deltaAmount = +deltaAmount.toFixed(2);

      // Only create a charge if the agreed rate actually differs. A zero
      // or negative-rounding delta means "same rate" → nothing to add.
      if (Math.abs(deltaAmount) > 0.009) {
        // Reuse the reservation's own snapshotted GST rate so the
        // extension follows the same tax treatment as the original
        // nights — never re-derive from the slab based on the new
        // rate. Re-deriving caused a single booking to carry rooms
        // at one rate and an extension line at a different rate
        // (e.g. 0% room + 5% extension when the new rate crossed a
        // slab boundary).
        const gstRate = Number(current.gstRate);
        // In inclusive mode, convert the gross delta to its net portion
        // so recalc's add-GST-on-top yields the original gross. In
        // exclusive mode the delta is already net — store as-is.
        const storedAmount =
          reservationGstMode === "inclusive"
            ? calcGstBreakdown(deltaAmount, gstRate, "inclusive").subtotal
            : deltaAmount;
        const nightWord = extraNights === 1 ? "night" : "nights";
        // Describe the line as a RATE DELTA, not a full nightly charge.
        // The added night(s) are already billed on the room line at the
        // original rate; this charge captures only the difference. Using
        // "₹X/n" in the description previously read as "this line costs
        // ₹X" which is misleading.
        const sample = assigned[0]
          ? Number(assigned[0].ratePerNight)
          : input.ratePerNight;
        const uniform = assigned.every(
          (rm) => Math.abs(Number(rm.ratePerNight) - sample) < 0.009,
        );
        const rateChange =
          assigned.length > 0 && uniform
            ? ` (${assigned.length === 1 ? "" : `${assigned.length} rooms `}₹${sample.toFixed(0)} → ₹${input.ratePerNight.toFixed(0)})`
            : "";
        const inclLabel = reservationGstMode === "inclusive" ? " (incl. GST)" : "";
        const [charge] = await db
          .insert(additionalCharges)
          .values({
            reservationId: id,
            description: `Stay extension rate adjustment — ${extraNights} ${nightWord}${rateChange}${inclLabel}`,
            quantity: 1,
            rate: String(storedAmount.toFixed(2)),
            amount: String(storedAmount.toFixed(2)),
            gstRate: String(gstRate),
            addedBy: req.user!.id,
          })
          .returning();
        extensionChargeId = charge?.id ?? null;
      }
    }

    // Extend the dates only. The room rate is intentionally left as-is so
    // existing nights aren't re-priced.
    //
    // plannedCheckOutAt (the staff-chosen checkout *time*) must roll forward
    // to the new date too, otherwise the reservation header keeps showing the
    // old "Out" date — it prioritises plannedCheckOutAt over checkOutDate.
    // Preserve the exact instant-of-day by shifting the timestamp by the
    // whole-day delta between old and new check-out dates. Doing it as a ms
    // offset (rather than mutating the calendar fields) is timezone-safe
    // regardless of the server's TZ.
    let newPlannedCheckOutAt: Date | undefined;
    if (current.plannedCheckOutAt) {
      const dayMs = 24 * 60 * 60 * 1000;
      const deltaDays = Math.round(
        (new Date(input.newCheckOutDate).getTime() -
          new Date(current.checkOutDate).getTime()) /
          dayMs,
      );
      newPlannedCheckOutAt = new Date(
        new Date(current.plannedCheckOutAt).getTime() + deltaDays * dayMs,
      );
    }

    await db
      .update(reservations)
      .set({
        checkOutDate: input.newCheckOutDate,
        ...(newPlannedCheckOutAt ? { plannedCheckOutAt: newPlannedCheckOutAt } : {}),
        // Remember the first-booked check-out the first time a reservation is
        // extended (drives the "Extended" marker). Never overwritten on
        // subsequent extends, so it always holds the true original.
        ...(current.originalCheckOutDate ? {} : { originalCheckOutDate: current.checkOutDate }),
        updatedAt: new Date(),
      })
      .where(eq(reservations.id, id));

    await recalcReservation(id);
    const [updated] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);

    await logActivity({
      action: "reservation_extended",
      entityType: "reservation",
      entityId: id,
      description: input.ratePerNight
        ? `${current.reservationNumber} extended to ${input.newCheckOutDate} (+${extraNights} night${extraNights === 1 ? "" : "s"} @ ₹${input.ratePerNight.toFixed(2)})`
        : `${current.reservationNumber} extended to ${input.newCheckOutDate} (+${extraNights} night${extraNights === 1 ? "" : "s"} at existing rate)`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        oldCheckOut: current.checkOutDate,
        newCheckOut: input.newCheckOutDate,
        extraNights,
        extensionRate: input.ratePerNight ?? null,
        extensionChargeId,
      },
    });
    await invalidateDashboard();
    return ok(res, updated);
  },
);

// Partial-room extend (split). When only SOME rooms on a multi-room
// reservation want to stay longer, this endpoint:
//   1. Creates a brand-new reservation (new SLDT-RES-XXXX number) that
//      copies the source's guest, dates (check-in = source check-in,
//      check-out = the extended date), rate config, and GST mode.
//   2. Moves the picked reservation_rooms rows from the source to the
//      new reservation in the same tx.
//   3. Recomputes totals on BOTH reservations: the source now has
//      fewer rooms, the new one has the picked rooms over the extended
//      window.
//   4. Optionally adds a "Stay extension" charge on the NEW reservation
//      when a different rate-per-night was agreed for the new nights.
// Invoiced rooms, cancelled rooms, and "extend all rooms" callers are
// rejected with friendly errors pointing them at the right endpoint.
router.post(
  "/:id/extend-split",
  requireAuth,
  requirePermission("view_reservations"),
  idempotent("reservations.extendSplit"),
  validate(extendSplitSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as {
      newCheckOutDate: string;
      roomIds: string[];
      ratePerNight?: number;
    };

    const [current] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    if (!current) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (current.status !== "confirmed" && current.status !== "checked_in") {
      return fail(
        res,
        400,
        "INVALID_STATE",
        "Only confirmed or checked-in reservations can be extended",
      );
    }
    if (current.stayType === "short_stay") {
      return fail(
        res,
        400,
        "SHORT_STAY_NOT_EXTENDABLE",
        "Short-stay (day-use) bookings can't be extended. Create a new reservation instead.",
      );
    }
    if (new Date(input.newCheckOutDate) <= new Date(current.checkOutDate)) {
      return fail(res, 400, "INVALID_DATES", "New check-out must be after current check-out");
    }

    const allRooms = await db
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, id));
    const pickedSet = new Set(input.roomIds);
    const picked = allRooms.filter((r) => pickedSet.has(r.roomId));
    if (picked.length === 0) {
      return fail(
        res,
        400,
        "NO_ROOMS_PICKED",
        "Pick at least one room to extend onto a new reservation",
      );
    }
    if (picked.length !== input.roomIds.length) {
      return fail(
        res,
        404,
        "ROOM_NOT_ON_RESERVATION",
        "One or more selected rooms aren't on this reservation",
      );
    }
    if (picked.length === allRooms.length) {
      return fail(
        res,
        400,
        "USE_FULL_EXTEND",
        "All rooms picked — use POST /extend (full-reservation extension) instead of split",
      );
    }
    // Block split when any picked room is already on an invoice — its
    // bill is locked and cannot be moved to a new reservation.
    const invoiced = picked.find((r) => r.invoiceId);
    if (invoiced) {
      return fail(
        res,
        409,
        "ROOM_ALREADY_INVOICED",
        "A picked room already has an invoice. Void it first or pick rooms without invoices.",
        { roomId: invoiced.roomId },
      );
    }
    // Block cancelled per-room rows — moving a cancelled-status row to
    // a fresh reservation would silently revive it.
    const stale = picked.find(
      (r) => r.status === "cancelled" || r.status === "checked_out",
    );
    if (stale) {
      return fail(
        res,
        409,
        "ROOM_INACTIVE",
        `Picked room is ${stale.status}; only active rooms can be moved to a new reservation`,
        { roomId: stale.roomId },
      );
    }

    // Availability for each picked room over the EXTENSION window only.
    // The current window [checkIn, checkOutDate) is unchanged on the new
    // reservation; the conflict probe runs against [oldCheckOut, newCheckOut).
    for (const rm of picked) {
      const ok = await isRoomAvailable(
        rm.roomId,
        current.checkOutDate,
        input.newCheckOutDate,
        id,
      );
      if (!ok) {
        return fail(
          res,
          409,
          "ROOM_UNAVAILABLE",
          "Picked room is not available for the extended period",
          { roomId: rm.roomId },
        );
      }
    }

    const reservationGstMode = current.gstMode ?? "exclusive";

    let newReservationId = "";
    let newReservationNumber = "";
    await db.transaction(async (tx) => {
      const seq = await nextDailySequence(`SLDT-RES-%`, tx);
      newReservationNumber = reservationNumber(seq);

      // Snapshot a starter row. totals/grandTotal/balance get rewritten
      // by recalcReservation in a moment; we just need a valid initial
      // row (notNull columns + sane defaults).
      const composedSpecial = current.specialRequests
        ? `Split from ${current.reservationNumber} — extended to ${input.newCheckOutDate}. Original notes: ${current.specialRequests}`
        : `Split from ${current.reservationNumber} — extended to ${input.newCheckOutDate}`;
      const [created] = await tx
        .insert(reservations)
        .values({
          reservationNumber: newReservationNumber,
          propertyId: current.propertyId,
          guestId: current.guestId,
          checkInDate: current.checkInDate,
          checkOutDate: input.newCheckOutDate,
          stayType: current.stayType,
          numAdults: current.numAdults,
          numChildren: current.numChildren,
          ratePerNight: current.ratePerNight,
          subtotal: "0",
          gstRate: current.gstRate,
          gstAmount: "0",
          grandTotal: "0",
          gstMode: reservationGstMode,
          // Money stays with the source reservation. The new
          // reservation starts with zero advance / wallet credit —
          // staff collects what's owed on it through its own check-out.
          advancePaid: "0",
          walletCreditApplied: "0",
          balanceDue: "0",
          status: current.status,
          bookingSource: current.bookingSource,
          specialRequests: composedSpecial,
          checkedInAt: current.status === "checked_in" ? current.checkedInAt : null,
          checkedInBy: current.status === "checked_in" ? current.checkedInBy : null,
          createdBy: req.user!.id,
        })
        .returning();
      newReservationId = created!.id;

      // Move the picked reservation_rooms rows to the new reservation.
      const pickedRowIds = picked.map((r) => r.id);
      await tx
        .update(reservationRooms)
        .set({ reservationId: newReservationId })
        .where(inArray(reservationRooms.id, pickedRowIds));

      // Optional rate-delta charge on the NEW reservation only — the
      // source's billing is untouched. Mirrors the existing /extend
      // logic but scoped to the new reservation.
      if (input.ratePerNight && picked.length > 0) {
        const extraNights = differenceInCalendarDays(
          new Date(input.newCheckOutDate),
          new Date(current.checkOutDate),
        );
        let deltaAmount = 0;
        for (const rm of picked) {
          const delta = (input.ratePerNight - Number(rm.ratePerNight)) * extraNights;
          deltaAmount += delta;
        }
        deltaAmount = +deltaAmount.toFixed(2);
        if (Math.abs(deltaAmount) > 0.009) {
          // Inherit the reservation's locked GST rate — see /extend
          // for the rationale (same booking, same tax treatment).
          const gstRate = Number(current.gstRate);
          const storedAmount =
            reservationGstMode === "inclusive"
              ? calcGstBreakdown(deltaAmount, gstRate, "inclusive").subtotal
              : deltaAmount;
          const nightWord = extraNights === 1 ? "night" : "nights";
          const sample = picked[0]
            ? Number(picked[0].ratePerNight)
            : input.ratePerNight;
          const uniform = picked.every(
            (rm) => Math.abs(Number(rm.ratePerNight) - sample) < 0.009,
          );
          const rateChange =
            picked.length > 0 && uniform
              ? ` (${picked.length === 1 ? "" : `${picked.length} rooms `}₹${sample.toFixed(0)} → ₹${input.ratePerNight.toFixed(0)})`
              : "";
          const inclLabel = reservationGstMode === "inclusive" ? " (incl. GST)" : "";
          await tx.insert(additionalCharges).values({
            reservationId: newReservationId,
            description: `Stay extension rate adjustment — ${extraNights} ${nightWord}${rateChange}${inclLabel}`,
            quantity: 1,
            rate: String(storedAmount.toFixed(2)),
            amount: String(storedAmount.toFixed(2)),
            gstRate: String(gstRate),
            addedBy: req.user!.id,
          });
        }
      }
    });

    // Recompute totals on BOTH reservations now that rooms have moved.
    // recalcReservation reads the current reservation_rooms rows, so the
    // source loses the picked rooms and the new one gains them.
    await recalcReservation(id);
    await recalcReservation(newReservationId);

    const [refreshedSource] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    const [refreshedNew] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, newReservationId))
      .limit(1);

    const extraNights = differenceInCalendarDays(
      new Date(input.newCheckOutDate),
      new Date(current.checkOutDate),
    );

    // Audit log on both — staff can trace which split created which
    // pair, and the source's history shows where the rooms went.
    await logActivity({
      action: "reservation_extended_split",
      entityType: "reservation",
      entityId: id,
      description: `${current.reservationNumber} split: ${picked.length} room${picked.length === 1 ? "" : "s"} moved to ${newReservationNumber} (extended to ${input.newCheckOutDate}, +${extraNights} night${extraNights === 1 ? "" : "s"})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        sourceReservationId: id,
        sourceReservationNumber: current.reservationNumber,
        newReservationId,
        newReservationNumber,
        movedRoomIds: picked.map((r) => r.roomId),
        oldCheckOut: current.checkOutDate,
        newCheckOut: input.newCheckOutDate,
        extraNights,
        extensionRate: input.ratePerNight ?? null,
      },
    });
    await logActivity({
      action: "reservation_created_from_split",
      entityType: "reservation",
      entityId: newReservationId,
      description: `${newReservationNumber} created from split of ${current.reservationNumber}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        sourceReservationId: id,
        sourceReservationNumber: current.reservationNumber,
      },
    });

    await invalidateDashboard();
    return ok(res, {
      source: refreshedSource,
      created: refreshedNew,
    });
  },
);

// Pre-flight for the Extend Stay modal: which of this reservation's
// rooms are free for the extension window [currentCheckOut, newCheckOut),
// which are blocked by another booking (and by whom), and which OTHER
// rooms are free and could take a blocked room's guest instead.
router.get(
  "/:id/extend-options",
  requireAuth,
  requirePermission("view_reservations"),
  validate(extendOptionsQuerySchema, "query"),
  async (req, res) => {
    const id = req.params.id!;
    const { newCheckOutDate } = req.query as unknown as { newCheckOutDate: string };

    const [current] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    if (!current) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (current.stayType === "short_stay") {
      return fail(
        res,
        400,
        "SHORT_STAY_NOT_EXTENDABLE",
        "Short-stay (day-use) bookings can't be extended.",
      );
    }
    if (new Date(newCheckOutDate) <= new Date(current.checkOutDate)) {
      return fail(res, 400, "INVALID_DATES", "New check-out must be after current check-out");
    }

    const assigned = await db
      .select({ rr: reservationRooms, room: rooms })
      .from(reservationRooms)
      .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
      .where(eq(reservationRooms.reservationId, id));

    // Conflicts over the extension window only — the current stay is
    // unchanged. Exclude this reservation so its own rows don't count.
    const conflictByRoom = await findRoomConflicts(current.checkOutDate, newCheckOutDate, {
      excludeReservationId: id,
    });

    // One state per distinct room (swap segments can produce multiple
    // rows for the same room id — the active one wins).
    const stateByRoom = new Map<
      string,
      {
        roomId: string;
        roomNumber: string;
        invoiced: boolean;
        available: boolean;
        conflict: RoomConflict | null;
      }
    >();
    for (const x of assigned) {
      if (x.rr.status === "cancelled" || x.rr.status === "checked_out") continue;
      stateByRoom.set(x.room.id, {
        roomId: x.room.id,
        roomNumber: x.room.roomNumber,
        invoiced: !!x.rr.invoiceId,
        available: !conflictByRoom.has(x.room.id),
        conflict: conflictByRoom.get(x.room.id) ?? null,
      });
    }

    // Rooms free for the extension window that could take a blocked
    // room's guest. Excludes rooms already on this reservation.
    const assignedIds = new Set(assigned.map((x) => x.room.id));
    const free = await findAvailableRooms(current.checkOutDate, newCheckOutDate);
    const alternatives = free
      .filter((r) => !assignedIds.has(r.id) && !r.conflict)
      .map((r) => ({
        id: r.id,
        roomNumber: r.roomNumber,
        roomType: r.roomType,
        baseRate: r.baseRate,
        status: r.status,
      }));

    return ok(res, { rooms: Array.from(stateByRoom.values()), alternatives });
  },
);

// Continuation booking: the guest stays past the current check-out but
// in a DIFFERENT room (their room is taken by another booking for the
// new night(s)). Creates a fresh reservation [oldCheckOut, newCheckOut)
// for the same guest — no detail re-entry. The source reservation's
// dates and billing are untouched; the guest physically moves rooms on
// the changeover day.
//
// OTP-GATED: the guest confirms via a code sent to their phone/email
// (POST /otp/send { reservationId }). The code is verified and consumed
// inside the creation transaction so one code can't confirm two
// bookings.
router.post(
  "/:id/extend-continue",
  requireAuth,
  requirePermission("view_reservations"),
  idempotent("reservations.extendContinue"),
  validate(extendContinueSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as {
      newCheckOutDate: string;
      moves: { fromRoomId: string; toRoomId: string; ratePerNight?: number }[];
      otpCode: string;
    };

    const [current] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    if (!current) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (current.status !== "confirmed" && current.status !== "checked_in") {
      return fail(
        res,
        400,
        "INVALID_STATE",
        "Only confirmed or checked-in reservations can be continued",
      );
    }
    if (current.stayType === "short_stay") {
      return fail(
        res,
        400,
        "SHORT_STAY_NOT_EXTENDABLE",
        "Short-stay (day-use) bookings can't be extended. Create a new reservation instead.",
      );
    }
    if (new Date(input.newCheckOutDate) <= new Date(current.checkOutDate)) {
      return fail(res, 400, "INVALID_DATES", "New check-out must be after current check-out");
    }

    const assigned = await db
      .select({ rr: reservationRooms, room: rooms })
      .from(reservationRooms)
      .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
      .where(eq(reservationRooms.reservationId, id));
    const activeByRoomId = new Map(
      assigned
        .filter((x) => x.rr.status !== "cancelled" && x.rr.status !== "checked_out")
        .map((x) => [x.room.id, x]),
    );

    const toIds = input.moves.map((m) => m.toRoomId);
    if (new Set(toIds).size !== toIds.length) {
      return fail(res, 400, "DUPLICATE_TARGET", "Each move must target a different room");
    }
    for (const mv of input.moves) {
      if (!activeByRoomId.has(mv.fromRoomId)) {
        return fail(res, 404, "ROOM_NOT_ON_RESERVATION", "Source room isn't on this reservation", {
          roomId: mv.fromRoomId,
        });
      }
      if (activeByRoomId.has(mv.toRoomId)) {
        return fail(
          res,
          409,
          "TARGET_ON_RESERVATION",
          "Target room is already part of this reservation — extend it instead",
          { roomId: mv.toRoomId },
        );
      }
    }
    const targetRooms = await db.select().from(rooms).where(inArray(rooms.id, toIds));
    const targetById = new Map(targetRooms.map((r) => [r.id, r]));
    for (const mv of input.moves) {
      const target = targetById.get(mv.toRoomId);
      if (!target) {
        return fail(res, 404, "TARGET_ROOM_NOT_FOUND", "Target room not found", {
          roomId: mv.toRoomId,
        });
      }
      const okAvail = await isRoomAvailable(
        mv.toRoomId,
        current.checkOutDate,
        input.newCheckOutDate,
        id,
      );
      if (!okAvail) {
        return fail(
          res,
          409,
          "TARGET_UNAVAILABLE",
          `Room ${target.roomNumber} is not available for the extension period`,
          { roomId: mv.toRoomId },
        );
      }
    }

    // ---- OTP gate. Mirrors POST /otp/verify but defers consumption to
    // the creation transaction (same pattern as the OTP-verified
    // reservation-create flow).
    const [otpRow] = await db
      .select()
      .from(otps)
      .where(and(eq(otps.reservationId, id), isNull(otps.consumedAt)))
      .orderBy(desc(otps.createdAt))
      .limit(1);
    if (!otpRow) {
      return fail(res, 400, "OTP_REQUIRED", "Send a verification code to the guest first");
    }
    if (otpRow.expiresAt < new Date()) {
      return fail(res, 400, "OTP_EXPIRED", "The code has expired — send a new one");
    }
    if (otpRow.attempts >= env.OTP_MAX_ATTEMPTS) {
      return fail(res, 429, "TOO_MANY_ATTEMPTS", "Too many wrong attempts — send a new code");
    }
    if (otpRow.codeHash !== hashOtp(input.otpCode)) {
      await db
        .update(otps)
        .set({ attempts: otpRow.attempts + 1 })
        .where(eq(otps.id, otpRow.id));
      return fail(res, 400, "INVALID_CODE", "Incorrect code");
    }

    const moveDesc = input.moves
      .map(
        (mv) =>
          `${activeByRoomId.get(mv.fromRoomId)!.room.roomNumber} → ${targetById.get(mv.toRoomId)!.roomNumber}`,
      )
      .join(", ");

    let newReservationId = "";
    let newReservationNumber = "";
    await db.transaction(async (tx) => {
      // Consume the OTP first; the conditional WHERE makes a concurrent
      // replay of the same code lose the race.
      const consumed = await tx
        .update(otps)
        .set({ consumedAt: new Date() })
        .where(and(eq(otps.id, otpRow.id), isNull(otps.consumedAt)))
        .returning({ id: otps.id });
      if (consumed.length === 0) {
        throw new Error("OTP was already used — request a new code");
      }

      const seq = await nextDailySequence(`SLDT-RES-%`, tx);
      newReservationNumber = reservationNumber(seq);
      const [created] = await tx
        .insert(reservations)
        .values({
          reservationNumber: newReservationNumber,
          propertyId: current.propertyId,
          guestId: current.guestId,
          checkInDate: current.checkOutDate,
          checkOutDate: input.newCheckOutDate,
          stayType: "overnight",
          numAdults: current.numAdults,
          numChildren: current.numChildren,
          ratePerNight: current.ratePerNight,
          subtotal: "0",
          // Same guest continuing the same stay — keep the snapshotted
          // tax treatment (see /extend for the rationale).
          gstRate: current.gstRate,
          gstAmount: "0",
          grandTotal: "0",
          gstMode: current.gstMode ?? "exclusive",
          // Money stays with the source reservation; the continuation
          // bills and collects on its own.
          advancePaid: "0",
          walletCreditApplied: "0",
          balanceDue: "0",
          status: "confirmed",
          bookingSource: current.bookingSource,
          specialRequests: `Continuation of ${current.reservationNumber} — room change ${moveDesc}. Confirmed by guest via OTP.`,
          createdBy: req.user!.id,
        })
        .returning();
      newReservationId = created!.id;

      for (const mv of input.moves) {
        const src = activeByRoomId.get(mv.fromRoomId)!;
        const rate = mv.ratePerNight ?? Number(src.rr.ratePerNight);
        await tx.insert(reservationRooms).values({
          reservationId: newReservationId,
          roomId: mv.toRoomId,
          ratePerNight: rate.toFixed(2),
          guestId: src.rr.guestId,
          status: "confirmed",
        });
      }
    });

    await recalcReservation(newReservationId);

    const [refreshedNew] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, newReservationId))
      .limit(1);

    await logActivity({
      action: "reservation_continued_room_change",
      entityType: "reservation",
      entityId: id,
      description: `${current.reservationNumber} continued to ${input.newCheckOutDate} as ${newReservationNumber} with room change (${moveDesc}) — guest confirmed via OTP`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        sourceReservationId: id,
        sourceReservationNumber: current.reservationNumber,
        newReservationId,
        newReservationNumber,
        moves: input.moves,
        oldCheckOut: current.checkOutDate,
        newCheckOut: input.newCheckOutDate,
      },
    });

    await invalidateDashboard();
    return ok(res, { created: refreshedNew });
  },
);

router.post(
  "/:id/late-checkout",
  requireAuth,
  requirePermission("view_reservations"),
  validate(lateCheckoutSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as { hours: number; fee: number; notes?: string | null };

    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r[0]) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (r[0].status !== "confirmed" && r[0].status !== "checked_in") {
      return fail(res, 400, "INVALID_STATE", "Only active reservations can have late checkout");
    }
    if (r[0].stayType === "short_stay") {
      return fail(
        res,
        400,
        "SHORT_STAY_NO_LATE_CHECKOUT",
        "Late checkout doesn't apply to short-stay (day-use) bookings.",
      );
    }

    const description = `Late checkout (${input.hours} hrs)${input.notes ? `: ${input.notes}` : ""}`;
    const [charge] = await db
      .insert(additionalCharges)
      .values({
        reservationId: id,
        description,
        quantity: 1,
        rate: String(input.fee),
        amount: String(input.fee),
        gstRate: "0",
        addedBy: req.user!.id,
      })
      .returning();

    // Always persist the granted hours so the dashboard's checkout-alert
    // query can compute the effective check-out time. Hours stack with any
    // prior late-checkout grant for the same stay.
    const cumulativeHours = +(
      Number(r[0].lateCheckoutHours ?? 0) + input.hours
    ).toFixed(2);
    if (input.fee > 0) {
      const newGrand = +(Number(r[0].grandTotal) + input.fee).toFixed(2);
      await db.transaction(async (tx) => {
        await tx
          .update(reservations)
          .set({
            grandTotal: String(newGrand),
            lateCheckoutHours: String(cumulativeHours),
            updatedAt: new Date(),
          })
          .where(eq(reservations.id, id));
        // balanceDue follows grandTotal change — recompute from facts.
        await recomputeReservationBalance(tx, id);
      });
    } else {
      await db
        .update(reservations)
        .set({
          lateCheckoutHours: String(cumulativeHours),
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, id));
    }

    await logActivity({
      action: "late_checkout",
      entityType: "reservation",
      entityId: id,
      description: `${r[0].reservationNumber}: late checkout ${input.hours}h (₹${input.fee})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { hours: input.hours, fee: input.fee },
    });
    return ok(res, charge, 201);
  },
);

router.post(
  "/:id/add-room",
  requireAuth,
  requirePermission("view_reservations"),
  validate(addRoomSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as {
      roomId: string;
      ratePerNight: number;
      soldAsType?: string | null;
      startDate?: string;
    };

    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r[0]) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    const current = r[0];
    if (current.status !== "confirmed" && current.status !== "checked_in") {
      return fail(res, 400, "INVALID_STATE", "Can only add rooms to active reservations");
    }

    const existing = await db
      .select({ roomId: reservationRooms.roomId })
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, id));
    if (existing.some((x) => x.roomId === input.roomId)) {
      return fail(res, 400, "DUPLICATE_ROOM", "Room already assigned to this reservation");
    }

    const today = propertyToday();
    const isShortStay = current.stayType === "short_stay";
    // For day-use (short_stay): check-in == check-out, so "nights"
    // math is meaningless. The room is added at a flat rate equal to
    // the parent's short-stay price. Availability is probed against a
    // [d, d+1) window so the conflict check sees the day-use overlap
    // (mirrors the findAvailableRooms split on stayType).
    const startDate = isShortStay
      ? current.checkInDate
      : input.startDate ?? (current.checkInDate > today ? current.checkInDate : today);
    if (!isShortStay && startDate >= current.checkOutDate) {
      return fail(res, 400, "INVALID_DATES", "Start date must be before check-out date");
    }

    // Probe window. Overnight uses [start, checkOut). Day-use widens
    // the end by one day so the empty-range corner case in
    // isRoomAvailable's daterange overlap is avoided.
    const probeEnd = isShortStay
      ? format(
          new Date(new Date(current.checkInDate).getTime() + 86400000),
          "yyyy-MM-dd",
        )
      : current.checkOutDate;
    const ok2 = await isRoomAvailable(input.roomId, startDate, probeEnd, id);
    if (!ok2) {
      return fail(res, 409, "ROOM_UNAVAILABLE", "Room is not available for the selected period", {
        roomId: input.roomId,
      });
    }

    // Day-use rooms bill at one FLAT charge (input.ratePerNight is the
    // agreed total for the duration). Overnight rooms multiply by the
    // remaining nights.
    const addedNights = isShortStay
      ? 1
      : differenceInCalendarDays(
          new Date(current.checkOutDate),
          new Date(startDate),
        );
    const addedRoomAmount = +(input.ratePerNight * addedNights).toFixed(2);

    // Inherit the reservation's snapshotted GST rate + mode. Adding a
    // room must NOT re-derive from the slab — that bumped the entire
    // reservation's tax rate whenever the new room crossed a slab
    // boundary, silently re-taxing rooms already on the bill.
    const gstMode = current.gstMode ?? "exclusive";
    const effectiveGstRate = Number(current.gstRate);
    // Combine the existing booking with the added room. In exclusive
    // mode we sum the stored net subtotals (input.ratePerNight is net).
    // In inclusive mode we sum gross amounts (input.ratePerNight is gross,
    // current.grandTotal is gross) and let the breakdown helper extract
    // the new net subtotal.
    const combinedAmount =
      gstMode === "inclusive"
        ? +(Number(current.grandTotal) + addedRoomAmount).toFixed(2)
        : +(Number(current.subtotal) + addedRoomAmount).toFixed(2);
    const {
      subtotal: newSubtotal,
      gstAmount,
      grandTotal,
    } = calcGstBreakdown(combinedAmount, effectiveGstRate, gstMode);

    await db.transaction(async (tx) => {
      await tx.insert(reservationRooms).values({
        reservationId: id,
        roomId: input.roomId,
        ratePerNight: String(input.ratePerNight),
        soldAsType: input.soldAsType ?? null,
        // Mid-stay add-room: occupant defaults to the booker, status
        // mirrors the parent reservation so a checked-in reservation's
        // added room is immediately occupied. Reassign via the
        // per-room assign-guest endpoint when the new room is for a
        // different person.
        guestId: current.guestId,
        status:
          current.status === "checked_in"
            ? ("checked_in" as const)
            : ("confirmed" as const),
        checkedInAt: current.status === "checked_in" ? new Date() : null,
        checkedInBy: current.status === "checked_in" ? req.user!.id : null,
      });
      await tx
        .update(reservations)
        .set({
          subtotal: String(newSubtotal),
          gstRate: String(effectiveGstRate),
          gstAmount: String(gstAmount),
          grandTotal: String(grandTotal),
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, id));
      await tx
        .update(rooms)
        .set({
          status: current.status === "checked_in" ? "occupied" : "reserved",
          updatedAt: new Date(),
        })
        .where(eq(rooms.id, input.roomId));
      // Roll the new balanceDue from the new grandTotal.
      await recomputeReservationBalance(tx, id);
    });

    await logActivity({
      action: "room_added",
      entityType: "reservation",
      entityId: id,
      description: `${current.reservationNumber}: room added (${addedNights}n @ ₹${input.ratePerNight})`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { roomId: input.roomId, startDate, ratePerNight: input.ratePerNight },
    });
    await invalidateDashboard();
    return ok(res, { success: true, addedSubtotal: addedRoomAmount, newGrandTotal: grandTotal }, 201);
  },
);

async function getReservationRoomNumbers(reservationId: string): Promise<string> {
  const rows = await db
    .select({ roomNumber: rooms.roomNumber })
    .from(reservationRooms)
    .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
    .where(eq(reservationRooms.reservationId, reservationId))
    .orderBy(rooms.roomNumber);
  return rows.map((r) => r.roomNumber).join(", ");
}

async function recalcReservation(id: string) {
  const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
  if (!r[0]) return null;
  const current = r[0];

  const assigned = await db
    .select({ ratePerNight: reservationRooms.ratePerNight })
    .from(reservationRooms)
    .where(eq(reservationRooms.reservationId, id));
  const charges = await db
    .select()
    .from(additionalCharges)
    .where(eq(additionalCharges.reservationId, id));

  // For short-stay, ratePerNight on reservation_rooms holds the FLAT
  // short-stay price for the chosen duration. The recalc multiplies by 1
  // (not by night count) so dates-edit / room-rate-edit on day-use bookings
  // recompute correctly. Overnight stays still multiply by nights.
  const isShortStay = current.stayType === "short_stay";
  const nights = isShortStay
    ? 1
    : differenceInCalendarDays(new Date(current.checkOutDate), new Date(current.checkInDate));
  // Mode-aware math, snapshotted from the reservation row so a later
  // settings flip doesn't rewrite history.
  //   exclusive: stored room rate IS net; sum gives net subtotal.
  //   inclusive: stored room rate IS gross; sum gives gross room total
  //              and we extract net subtotal via calcGstBreakdown.
  // additionalCharges always store a net amount + GST rate of their own
  // (the schema predates inclusive mode), so they get treated as
  // exclusive regardless of the reservation's mode.
  const reservationGstMode = current.gstMode ?? "exclusive";
  const roomAmount = assigned.reduce((a, rm) => a + Number(rm.ratePerNight) * nights, 0);

  // ALWAYS inherit the reservation's snapshotted GST rate. Re-deriving
  // from the slab on every recalc made the rate drift whenever the
  // average room rate crossed a slab boundary (e.g. after Add Room,
  // Extend Stay, or Edit Rate). The snapshot is set once at create
  // time and is the source of truth for the life of the booking.
  const roomGstRate = Number(current.gstRate);
  const roomBreakdown = calcGstBreakdown(roomAmount, roomGstRate, reservationGstMode);
  const roomNet = roomBreakdown.subtotal;
  const roomGst = roomBreakdown.gstAmount;
  const chargesSubtotal = charges.reduce((a, c) => a + Number(c.amount), 0);
  const chargesGst = charges.reduce(
    (a, c) => a + +(Number(c.amount) * (Number(c.gstRate) / 100)).toFixed(2),
    0,
  );
  const subtotal = +(roomNet + chargesSubtotal).toFixed(2);
  const gstAmount = +(roomGst + chargesGst).toFixed(2);
  const grandTotal = +(subtotal + gstAmount).toFixed(2);

  await db
    .update(reservations)
    .set({
      subtotal: String(subtotal),
      gstRate: String(roomGstRate),
      gstAmount: String(gstAmount),
      grandTotal: String(grandTotal),
      updatedAt: new Date(),
    })
    .where(eq(reservations.id, id));
  // Roll the balance from the new grandTotal + actual payments.
  const recomputed = await recomputeReservationBalance(db, id);
  return { subtotal, grandTotal, balanceDue: recomputed.balanceDue };
}

async function hasInvoice(reservationId: string) {
  const inv = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.reservationId, reservationId))
    .limit(1);
  return inv.length > 0;
}

router.patch(
  "/:id/rooms/:roomId",
  requireAuth,
  requirePermission("view_reservations"),
  validate(editRoomRateSchema),
  async (req, res) => {
    const { id, roomId } = req.params as { id: string; roomId: string };
    const { ratePerNight } = req.body as { ratePerNight: number };

    if (await hasInvoice(id)) {
      return fail(res, 400, "INVOICE_EXISTS", "Cannot edit rates after invoice is generated. Void invoice first.");
    }

    const [updated] = await db
      .update(reservationRooms)
      .set({ ratePerNight: String(ratePerNight) })
      .where(and(eq(reservationRooms.reservationId, id), eq(reservationRooms.roomId, roomId)))
      .returning();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Room not in reservation");

    const totals = await recalcReservation(id);
    await logActivity({
      action: "rate_edited",
      entityType: "reservation",
      entityId: id,
      description: `Room rate changed to ₹${ratePerNight}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { roomId, ratePerNight },
    });
    await invalidateDashboard();
    return ok(res, { success: true, ...totals });
  },
);

router.patch(
  "/:id/charges/:chargeId",
  requireAuth,
  requirePermission("view_reservations"),
  validate(editChargeSchema),
  async (req, res) => {
    const { id, chargeId } = req.params as { id: string; chargeId: string };
    const input = req.body as {
      description?: string;
      quantity?: number;
      rate?: number;
      gstRate?: number;
    };

    if (await hasInvoice(id)) {
      return fail(res, 400, "INVOICE_EXISTS", "Cannot edit charges after invoice is generated");
    }

    const existing = await db
      .select()
      .from(additionalCharges)
      .where(eq(additionalCharges.id, chargeId))
      .limit(1);
    if (!existing.length) return fail(res, 404, "NOT_FOUND", "Charge not found");

    const newQty = input.quantity ?? existing[0]!.quantity;
    const newRate = input.rate ?? Number(existing[0]!.rate);
    const newAmount = +(newQty * newRate).toFixed(2);

    const patch: Record<string, unknown> = { amount: String(newAmount) };
    if (input.description !== undefined) patch.description = input.description;
    if (input.quantity !== undefined) patch.quantity = input.quantity;
    if (input.rate !== undefined) patch.rate = String(input.rate);
    if (input.gstRate !== undefined) patch.gstRate = String(input.gstRate);

    await db.update(additionalCharges).set(patch).where(eq(additionalCharges.id, chargeId));
    const totals = await recalcReservation(id);

    await logActivity({
      action: "charge_edited",
      entityType: "reservation",
      entityId: id,
      description: `Charge edited: ${input.description ?? existing[0]!.description} ₹${newAmount}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { chargeId, ...input },
    });
    return ok(res, { success: true, ...totals });
  },
);

router.delete(
  "/:id/charges/:chargeId",
  requireAuth,
  requirePermission("view_reservations"),
  async (req, res) => {
    const { id, chargeId } = req.params as { id: string; chargeId: string };
    if (await hasInvoice(id)) {
      return fail(res, 400, "INVOICE_EXISTS", "Cannot delete charges after invoice is generated");
    }
    const [deleted] = await db
      .delete(additionalCharges)
      .where(eq(additionalCharges.id, chargeId))
      .returning();
    if (!deleted) return fail(res, 404, "NOT_FOUND", "Charge not found");
    const totals = await recalcReservation(id);

    await logActivity({
      action: "charge_deleted",
      entityType: "reservation",
      entityId: id,
      description: `Charge deleted: ${deleted.description}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    return ok(res, { success: true, ...totals });
  },
);

router.patch(
  "/:id/dates",
  requireAuth,
  requirePermission("view_reservations"),
  validate(editDatesSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { checkInDate, checkOutDate } = req.body as {
      checkInDate: string;
      checkOutDate: string;
    };
    if (await hasInvoice(id)) {
      return fail(res, 400, "INVOICE_EXISTS", "Cannot edit dates after invoice is generated");
    }

    const [stayRow] = await db
      .select({ stayType: reservations.stayType })
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    if (stayRow?.stayType === "short_stay" && checkInDate !== checkOutDate) {
      return fail(
        res,
        400,
        "INVALID_DATES",
        "Short-stay bookings must check-in and check-out on the same date",
      );
    }

    const assigned = await db
      .select({ roomId: reservationRooms.roomId })
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, id));
    // Day-use bookings collapse [d, d) to an empty range — widen the
    // probe to [d, d+1) so the short_stay branch in isRoomAvailable
    // actually checks for same-day conflicts.
    const probeOut =
      stayRow?.stayType === "short_stay"
        ? new Date(new Date(checkInDate).getTime() + 86400000)
            .toISOString()
            .slice(0, 10)
        : checkOutDate;
    for (const rm of assigned) {
      const ok2 = await isRoomAvailable(rm.roomId, checkInDate, probeOut, id);
      if (!ok2) {
        return fail(res, 409, "ROOM_UNAVAILABLE", "One or more rooms unavailable for the new dates", {
          roomId: rm.roomId,
        });
      }
    }

    await db
      .update(reservations)
      .set({ checkInDate, checkOutDate, updatedAt: new Date() })
      .where(eq(reservations.id, id));
    const totals = await recalcReservation(id);

    await logActivity({
      action: "dates_edited",
      entityType: "reservation",
      entityId: id,
      description: `Dates changed to ${checkInDate} → ${checkOutDate}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    await invalidateDashboard();
    return ok(res, { success: true, ...totals });
  },
);

router.get("/:id/charges", requireAuth, requirePermission("view_reservations"), async (req, res) => {
  const id = req.params.id!;
  const rows = await db
    .select()
    .from(additionalCharges)
    .where(eq(additionalCharges.reservationId, id))
    .orderBy(asc(additionalCharges.createdAt));
  return ok(res, rows);
});

router.get(
  "/:id/invoice-preview",
  requireAuth,
  requirePermission("view_reservations"),
  async (req, res) => {
    const id = req.params.id!;
    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");

    const settings = await getSettings();
    const guest = (await db.select().from(guests).where(eq(guests.id, r[0]!.guestId)).limit(1))[0]!;
    const resRooms = await db
      .select({ rr: reservationRooms, room: rooms })
      .from(reservationRooms)
      .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
      .where(eq(reservationRooms.reservationId, id));
    const charges = await db
      .select()
      .from(additionalCharges)
      .where(eq(additionalCharges.reservationId, id));
    const labelMap = await buildRoomTypeLabelMap();

    const nights = Number(r[0]!.numNights);
    const isShortStayPreview = r[0]!.stayType === "short_stay";
    const shortStayHoursPreview = Number(r[0]!.durationHours ?? 0);
    const roomGstRate = Number(r[0]!.gstRate);
    const previewGstMode = r[0]!.gstMode ?? "exclusive";

    let subtotal = 0;
    const lineItems = [] as Array<{
      id: string;
      invoiceId: string;
      description: string;
      sacCode: string;
      quantity: number;
      rate: string;
      amount: string;
      gstRate: string;
      gstAmount: string;
      itemType: "room_charge" | "additional_charge";
      createdAt: Date;
    }>;
    const now = new Date();

    // Swap chain index: for each swap_id, sort sibling segments by
    // effective_from. Then each row knows its predecessor / successor
    // so the line description can say "Swapped to Room 205" or
    // "Swapped from Room 203" instead of a vague "swapped" tag.
    // Mirrors the same computation done on the reservation detail
    // page so both surfaces speak the same language.
    const swapChains = new Map<
      string,
      { reservationRoomId: string; roomNumber: string; effectiveFrom: string }[]
    >();
    for (const rr of resRooms) {
      if (!rr.rr.swapId) continue;
      const arr = swapChains.get(rr.rr.swapId) ?? [];
      arr.push({
        reservationRoomId: rr.rr.id,
        roomNumber: rr.room.roomNumber,
        effectiveFrom: rr.rr.effectiveFrom ?? r[0]!.checkInDate,
      });
      swapChains.set(rr.rr.swapId, arr);
    }
    for (const arr of swapChains.values()) {
      arr.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    }
    // room id → number, so an in-place swap (swappedFromRoomId set, no
    // segmented sibling) can show "swapped from Room X" on the preview,
    // matching the real invoice.
    const previewRoomNumberById = await buildRoomNumberMap(resRooms);
    const previewSwapHops = await buildSwapHopsMap(resRooms.map((x) => x.rr.id));
    function swapSibling(
      reservationRoomId: string,
      swapId: string | null,
    ): { direction: "to" | "from"; roomNumber: string } | null {
      if (!swapId) return null;
      const chain = swapChains.get(swapId);
      if (!chain || chain.length < 2) return null;
      const idx = chain.findIndex((c) => c.reservationRoomId === reservationRoomId);
      if (idx < 0) return null;
      if (idx === chain.length - 1) {
        return { direction: "from", roomNumber: chain[idx - 1]!.roomNumber };
      }
      return { direction: "to", roomNumber: chain[idx + 1]!.roomNumber };
    }

    for (const rr of resRooms) {
      const storedRate = Number(rr.rr.ratePerNight);
      // Per-row nights for overnight stays. When a row was segmented
      // by a mid-stay swap (0019) it covers a sub-range of the parent
      // stay; count nights between effective_from and effective_to
      // instead of the parent's total. Falls back to the parent stay's
      // nights for unsegmented rows. Mirrors buildInvoice() so the
      // preview agrees with the real invoice on swap math — without
      // this, a swap shows 33 nights × 2 rooms = double billing in
      // the preview while the real invoice charges only 33 nights
      // total.
      const rowFrom = rr.rr.effectiveFrom ?? r[0]!.checkInDate;
      const rowTo = rr.rr.effectiveTo ?? r[0]!.checkOutDate;
      const rowNights = isShortStayPreview
        ? 1
        : Math.max(
            1,
            Math.round(
              (new Date(rowTo).getTime() - new Date(rowFrom).getTime()) /
                (24 * 60 * 60 * 1000),
            ),
          );
      const rowUnits = isShortStayPreview ? 1 : rowNights;

      const lineGross = +(storedRate * rowUnits).toFixed(2);
      const lineBreakdown = calcGstBreakdown(lineGross, roomGstRate, previewGstMode);
      const netRate =
        previewGstMode === "inclusive" && rowUnits > 0
          ? +(lineBreakdown.subtotal / rowUnits).toFixed(2)
          : storedRate;
      const amount = lineBreakdown.subtotal;
      const gstAmount = lineBreakdown.gstAmount;
      subtotal += amount;
      const displayType = combinedRoomTypeLabel(
        rr.room.roomType,
        rr.rr.soldAsType,
        labelMap,
      );
      // Segment label: if the row covers only part of the stay, show
      // that range AND tag it with the swap direction so the bill
      // reads naturally — "Room 203 (1 night ... · swapped to Room
      // 205)" / "Room 205 (32 nights ... · swapped from Room 203)".
      // The swap reason ("Maintenance" etc.) describes what happened
      // to the LEAVING room, so we only append it on the closed leg;
      // appending it on the new room reads as if the new room itself
      // were broken. Falls back to a plain "swapped" tag when the
      // sibling isn't resolvable (data race or pre-0019 legacy row).
      const isSegmented = !!(rr.rr.effectiveFrom || rr.rr.effectiveTo);
      const sibling = swapSibling(rr.rr.id, rr.rr.swapId);
      const swapTag = sibling
        ? `swapped ${sibling.direction} Room ${sibling.roomNumber}`
        : "swapped";
      const reasonSuffix =
        rr.rr.swapReason && sibling?.direction === "to"
          ? `: ${rr.rr.swapReason}`
          : "";
      // In-place swap (no segmentation): render the FULL path ending at the
      // current room ("swapped Room 101 → 102 → 103") from the 0037 history;
      // fall back to the single swappedFromRoomId hop.
      const previewHopChain = !isSegmented ? previewSwapHops.get(rr.rr.id) : undefined;
      const previewFromRooms =
        previewHopChain && previewHopChain.length > 0
          ? previewHopChain
          : !isSegmented && rr.rr.swappedFromRoomId
            ? (() => {
                const n = previewRoomNumberById.get(rr.rr.swappedFromRoomId!);
                return n ? [n] : [];
              })()
            : [];
      const previewSwapPath =
        previewFromRooms.length > 0
          ? [...previewFromRooms, rr.room.roomNumber].join(" → ")
          : null;
      const description = isShortStayPreview
        ? `Room ${rr.room.roomNumber} - ${displayType} (Day use · ${shortStayHoursPreview} hours)`
        : isSegmented
          ? `Room ${rr.room.roomNumber} - ${displayType} (${rowNights} night${rowNights === 1 ? "" : "s"}, ${rowFrom} → ${rowTo} · ${swapTag}${reasonSuffix})`
          : previewSwapPath
            ? `Room ${rr.room.roomNumber} - ${displayType} (${nights} night${nights === 1 ? "" : "s"} · swapped Room ${previewSwapPath})`
            : `Room ${rr.room.roomNumber} - ${displayType} (${nights} nights)`;
      lineItems.push({
        id: `preview-${rr.room.id}-${String(rowFrom)}`,
        invoiceId: "preview",
        description,
        // 996311 — Room/unit accommodation services. See checkout flow
        // (router POST /:id/check-out) for the same code on the real
        // invoice this preview mirrors.
        sacCode: "996311",
        quantity: rowUnits,
        rate: String(netRate),
        amount: String(amount),
        gstRate: String(roomGstRate),
        gstAmount: String(gstAmount),
        itemType: "room_charge",
        createdAt: now,
      });

      // Extra beds for this room — mirrors the real checkout builder so
      // the preview total matches the invoice that will be issued.
      const beds = Number(rr.rr.extraBeds ?? 0);
      const bedRate = Number(rr.rr.extraBedRate ?? 0);
      if (beds > 0 && bedRate > 0) {
        const bedQty = beds * rowUnits;
        const bedGross = +(bedRate * bedQty).toFixed(2);
        const bedBreakdown = calcGstBreakdown(bedGross, roomGstRate, previewGstMode);
        const bedNetRate =
          previewGstMode === "inclusive" && bedQty > 0
            ? +(bedBreakdown.subtotal / bedQty).toFixed(2)
            : bedRate;
        subtotal += bedBreakdown.subtotal;
        lineItems.push({
          id: `preview-${rr.room.id}-${String(rowFrom)}-xbed`,
          invoiceId: "preview",
          description: `Room ${rr.room.roomNumber} - Extra bed (${beds} × ${rowUnits} ${isShortStayPreview ? "day" : "night"}${rowUnits === 1 && beds === 1 ? "" : "s"})`,
          sacCode: "996311",
          quantity: bedQty,
          rate: String(bedNetRate),
          amount: String(bedBreakdown.subtotal),
          gstRate: String(roomGstRate),
          gstAmount: String(bedBreakdown.gstAmount),
          itemType: "room_charge",
          createdAt: now,
        });
      }
    }

    // Sum room-line GST instead of re-applying the rate to the subtotal —
    // avoids double counting in inclusive mode and matches the real
    // checkout flow's line-by-line math.
    let totalGst = +lineItems
      .reduce((s, li) => s + Number(li.gstAmount), 0)
      .toFixed(2);
    for (const c of charges) {
      const amount = Number(c.amount);
      const gstAmount = +(amount * (Number(c.gstRate) / 100)).toFixed(2);
      subtotal += amount;
      totalGst += gstAmount;
      lineItems.push({
        id: `preview-${c.id}`,
        invoiceId: "preview",
        description: c.description,
        sacCode: "9963",
        quantity: c.quantity,
        rate: String(c.rate),
        amount: String(amount),
        gstRate: String(c.gstRate),
        gstAmount: String(gstAmount),
        itemType: "additional_charge",
        createdAt: now,
      });
    }

    subtotal = +subtotal.toFixed(2);
    totalGst = +totalGst.toFixed(2);
    const cgst = +(totalGst / 2).toFixed(2);
    const sgst = +(totalGst - cgst).toFixed(2);
    const grandTotal = +(subtotal + totalGst).toFixed(2);
    const totalPaid = Number(r[0]!.advancePaid);
    const balanceDue = +(grandTotal - totalPaid).toFixed(2);
    const status: "issued" | "partial" | "paid" =
      balanceDue <= 0.009 ? "paid" : totalPaid > 0 ? "partial" : "issued";

    const previewInvoice = {
      id: "preview",
      invoiceNumber: "PREVIEW (not issued)",
      reservationId: id,
      guestId: r[0]!.guestId,
      hotelName: settings.hotelName,
      hotelAddress: settings.hotelAddress,
      hotelGstin: settings.hotelGstin,
      guestName: guest.fullName,
      guestAddress: guest.address ?? null,
      guestGstin: guest.gstin ?? null,
      subtotal: String(subtotal),
      cgstRate: String(+(roomGstRate / 2).toFixed(2)),
      cgstAmount: String(cgst),
      sgstRate: String(+(roomGstRate / 2).toFixed(2)),
      sgstAmount: String(sgst),
      grandTotal: String(grandTotal),
      totalPaid: String(totalPaid),
      balanceDue: String(balanceDue),
      status,
      notes: null as string | null,
      reissuedFrom: null as string | null,
      voidedReason: null as string | null,
      voidedBy: null as string | null,
      issuedBy: req.user!.id,
      issueDate: now,
      createdAt: now,
      updatedAt: now,
    };

    const existingPays = await db
      .select()
      .from(payments)
      .where(eq(payments.reservationId, id))
      .orderBy(desc(payments.paymentDate));

    const pdf = await renderInvoicePdf({
      invoice: previewInvoice as never,
      lineItems: lineItems as never,
      payments: existingPays,
      settings,
      stay: {
        checkInDate: r[0]!.checkInDate,
        checkOutDate: r[0]!.checkOutDate,
        numNights: Number(r[0]!.numNights),
        stayType: r[0]!.stayType,
        durationHours: r[0]!.durationHours ? Number(r[0]!.durationHours) : null,
        checkedInAt: r[0]!.checkedInAt ? r[0]!.checkedInAt.toISOString() : null,
        plannedCheckInAt: r[0]!.plannedCheckInAt
          ? r[0]!.plannedCheckInAt.toISOString()
          : null,
        plannedCheckOutAt: r[0]!.plannedCheckOutAt
          ? r[0]!.plannedCheckOutAt.toISOString()
          : null,
      },
      guestExtra: await loadGuestExtra(r[0]!.id),
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${r[0]!.reservationNumber}-preview.pdf"`,
    );
    return res.send(pdf);
  },
);

const advancePaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  paymentMethod: z.enum(["cash", "upi", "card", "bank_transfer"]),
  notes: z.string().max(500).optional(),
  // When set, the payment lands on this specific invoice (validated to
  // belong to this reservation). Without it, the server picks the first
  // invoice on the reservation — fine for single-invoice cases but wrong
  // when multiple per-room / combined invoices coexist.
  invoiceId: z.string().uuid().optional(),
});

router.post(
  "/:id/payments",
  requireAuth,
  requirePermission("view_reservations"),
  idempotent("reservations.advancePayment"),
  validate(advancePaymentSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as z.infer<typeof advancePaymentSchema>;

    const r = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r.length) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (r[0]!.status === "cancelled") {
      return fail(res, 409, "CANCELLED", "Reservation is cancelled");
    }

    // If the caller targeted a specific invoice, fetch + validate it.
    // Otherwise fall back to the first invoice on the reservation (legacy
    // single-invoice behaviour).
    let existingInvoice: (typeof invoices.$inferSelect)[] = [];
    if (input.invoiceId) {
      existingInvoice = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, input.invoiceId), eq(invoices.reservationId, id)))
        .limit(1);
      if (!existingInvoice.length) {
        return fail(res, 404, "INVOICE_NOT_FOUND", "Invoice not on this reservation");
      }
    } else {
      existingInvoice = await db
        .select()
        .from(invoices)
        .where(eq(invoices.reservationId, id))
        .limit(1);
    }

    const created = await db.transaction(async (tx) => {
      const rcpNum = await generateReceiptNumber(tx);
      const [pay] = await tx
        .insert(payments)
        .values({
          receiptNumber: rcpNum,
          propertyId: r[0]!.propertyId,
          invoiceId: existingInvoice[0]?.id ?? null,
          reservationId: id,
          amount: String(input.amount),
          paymentMethod: input.paymentMethod,
          status: "received",
          receivedBy: req.user!.id,
          notes: input.notes ?? null,
        })
        .returning();

      if (existingInvoice.length) {
        const inv = existingInvoice[0]!;
        const newTotalPaid = +(Number(inv.totalPaid) + input.amount).toFixed(2);
        const newBalance = +(Number(inv.grandTotal) - newTotalPaid).toFixed(2);
        const newStatus = newBalance <= 0.009 ? "paid" : "partial";
        await tx
          .update(invoices)
          .set({
            totalPaid: String(newTotalPaid),
            balanceDue: String(newBalance),
            status: newStatus,
            updatedAt: new Date(),
          })
          .where(eq(invoices.id, inv.id));
      }
      // Reservation balance is recomputed from facts. This is correct
      // both when the payment hit a specific invoice (multi-invoice
      // bookings keep their other invoices' debt intact) and when it
      // landed as a pre-invoice advance (no invoice exists yet).
      await recomputeReservationBalance(tx, id);
      return pay!;
    });

    await logActivity({
      action: "payment_recorded",
      entityType: "reservation",
      entityId: id,
      description: `Payment ₹${input.amount} via ${input.paymentMethod} on ${r[0]!.reservationNumber}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
    });
    await invalidateDashboard();
    return ok(res, created, 201);
  },
);

// Preview applying wallet credit to a reservation that already exists.
// Returns the maximum redeemable amount (min of guest balance and current
// balance due) so the dialog can show the cap.
router.get(
  "/:id/wallet-credit-preview",
  requireAuth,
  requirePermission("view_reservations"),
  async (req, res) => {
    const id = req.params.id!;
    const [r] = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r) return fail(res, 404, "NOT_FOUND", "Reservation not found");

    const balance = await getGuestBalance(r.guestId);
    const reservationBalanceDue = Number(r.balanceDue);
    const maxRedeemable = +Math.min(balance, Math.max(0, reservationBalanceDue)).toFixed(2);

    return ok(res, {
      reservationId: r.id,
      reservationNumber: r.reservationNumber,
      reservationBalanceDue,
      walletBalance: balance,
      walletCreditAlreadyApplied: Number(r.walletCreditApplied),
      maxRedeemable,
    });
  },
);

// Apply wallet credit to an existing reservation. Behaves as a discount —
// reduces reservation.balanceDue, increments reservation.walletCreditApplied,
// and adds a credit_used ledger entry. Capped server-side; refuses if the
// guest balance is too low or the reservation is cancelled.
const applyCreditSchema = z.object({
  amount: z.coerce.number().positive(),
});
router.post(
  "/:id/apply-wallet-credit",
  requireAuth,
  requirePermission("view_reservations"),
  idempotent("reservations.applyWalletCredit"),
  validate(applyCreditSchema),
  async (req, res) => {
    const id = req.params.id!;
    const { amount } = req.body as z.infer<typeof applyCreditSchema>;

    let result:
      | { reservation: typeof reservations.$inferSelect; applied: number; remainingBalance: number }
      | null = null;
    type ConflictInfo = { code: string; message: string; details?: unknown };
    const conflictRef: { value: ConflictInfo | null } = { value: null };

    try {
      result = await db.transaction(async (tx) => {
        const [r] = await tx.select().from(reservations).where(eq(reservations.id, id)).limit(1);
        if (!r) {
          conflictRef.value = { code: "NOT_FOUND", message: "Reservation not found" };
          throw new Error("ABORT");
        }
        if (r.status === "cancelled") {
          conflictRef.value = { code: "CANCELLED", message: "Reservation is cancelled" };
          throw new Error("ABORT");
        }
        const currentBalance = Number(r.balanceDue);
        if (currentBalance <= 0.009) {
          conflictRef.value = {
            code: "NO_BALANCE",
            message: "Reservation has no outstanding balance",
          };
          throw new Error("ABORT");
        }

        await lockKey(tx, `guest-wallet:${r.guestId}`);
        const walletBalance = await getGuestBalance(r.guestId, tx);

        // Cap requested amount at both the wallet balance and the remaining
        // bill — no over-applying, no negative wallet.
        const capped = +Math.min(amount, walletBalance, currentBalance).toFixed(2);
        if (capped <= 0.009) {
          conflictRef.value = {
            code: "INSUFFICIENT_WALLET_BALANCE",
            message: `Wallet balance is ₹${walletBalance.toFixed(2)} — nothing to apply.`,
            details: { walletBalance, currentBalance },
          };
          throw new Error("ABORT");
        }

        const newApplied = +(Number(r.walletCreditApplied) + capped).toFixed(2);

        await tx
          .update(reservations)
          .set({
            walletCreditApplied: String(newApplied),
            updatedAt: new Date(),
          })
          .where(eq(reservations.id, r.id));

        await tx.insert(guestLedger).values({
          guestId: r.guestId,
          entryType: "credit_used",
          amount: String(capped.toFixed(2)),
          reservationId: r.id,
          note: `Applied to booking ${r.reservationNumber}`,
          createdBy: req.user!.id,
        });

        // Recompute from facts — walletCreditApplied changed, so balanceDue
        // needs to follow it. This keeps the formula consistent with every
        // other money-event path.
        const rolled = await recomputeReservationBalance(tx, r.id);
        const [updated] = await tx
          .select()
          .from(reservations)
          .where(eq(reservations.id, r.id))
          .limit(1);

        return { reservation: updated!, applied: capped, remainingBalance: rolled.balanceDue };
      });
    } catch (err) {
      const c = conflictRef.value;
      if (err instanceof Error && err.message === "ABORT" && c) {
        return fail(res, 409, c.code, c.message, c.details);
      }
      throw err;
    }

    if (!result) {
      return fail(res, 500, "INTERNAL_ERROR", "Could not apply wallet credit");
    }

    await logActivity({
      action: "wallet_credit_applied",
      entityType: "reservation",
      entityId: id,
      description: `₹${result.applied.toFixed(2)} wallet credit applied to ${result.reservation.reservationNumber}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { applied: result.applied, remainingBalance: result.remainingBalance },
    });
    await invalidateDashboard();
    return ok(res, result);
  },
);

// ---------------------------------------------------------------------------
// Per-room operations (migration 0017 / 0018).
//
// These endpoints make multi-room reservations behave like 3 separate
// stays where required: each room has its own occupant, its own check-
// in / check-out timing, and its own invoice. The reservation row stays
// as the parent: its overall status is a roll-up of its rooms.
// ---------------------------------------------------------------------------

// Reassign the occupant of one room to a different guest. Default
// occupant is the booker; once staff knows who's actually staying
// where, they flip each room to the right guest. The new guest must
// already exist (created via Guests page); we don't create a guest
// inline here.
const assignGuestSchema = z.object({ guestId: z.string().uuid() });
router.post(
  "/:id/rooms/:roomId/assign-guest",
  requireAuth,
  requirePermission("edit_reservations"),
  validate(assignGuestSchema),
  async (req, res) => {
    const { id, roomId } = req.params as { id: string; roomId: string };
    const { guestId } = req.body as z.infer<typeof assignGuestSchema>;

    const [resv] = await db
      .select({ id: reservations.id, status: reservations.status })
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    if (!resv) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (resv.status === "cancelled") {
      return fail(res, 409, "CANCELLED", "Reservation is cancelled");
    }

    const [g] = await db
      .select({ id: guests.id, fullName: guests.fullName })
      .from(guests)
      .where(eq(guests.id, guestId))
      .limit(1);
    if (!g) return fail(res, 404, "GUEST_NOT_FOUND", "Guest not found");

    const [updated] = await db
      .update(reservationRooms)
      .set({ guestId })
      .where(and(eq(reservationRooms.reservationId, id), eq(reservationRooms.roomId, roomId)))
      .returning();
    if (!updated) return fail(res, 404, "ROOM_NOT_FOUND", "Room not in this reservation");

    await logActivity({
      action: "reservation_room_guest_assigned",
      entityType: "reservation_room",
      entityId: updated.id,
      description: `Room ${roomId} reassigned to ${g.fullName}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: { reservationId: id, guestId },
    });
    return ok(res, updated);
  },
);

// Quick quote — what's owed for one room before checkout. Used by
// the PerRoomCheckoutModal so staff can see the bill before
// collecting money. Returns the same numbers the per-room invoice
// would generate, so the modal can confidently say "guest owes
// exactly this much".
router.get(
  "/:id/rooms/:roomId/checkout-quote",
  requireAuth,
  requirePermission("check_out"),
  async (req, res) => {
    const { id, roomId } = req.params as { id: string; roomId: string };
    const [resv] = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!resv) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    const [allResRooms, allCharges] = await Promise.all([
      db
        .select({ rr: reservationRooms, room: rooms })
        .from(reservationRooms)
        .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
        .where(eq(reservationRooms.reservationId, id)),
      db
        .select()
        .from(additionalCharges)
        .where(eq(additionalCharges.reservationId, id)),
    ]);
    const scopedRooms = allResRooms.filter((x) => x.room.id === roomId);
    if (!scopedRooms.length) return fail(res, 404, "ROOM_NOT_FOUND", "Room not in this reservation");
    const labelMap = await buildRoomTypeLabelMap();

    // If this room is already linked to an invoice (per-room or combined),
    // the bill is THAT invoice's remaining balance — not a fresh re-quote.
    // Otherwise generate a "what would the per-room invoice look like"
    // preview the same way as before.
    const existingInvoiceId = scopedRooms[0]!.rr.invoiceId;
    if (existingInvoiceId) {
      const [inv] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, existingInvoiceId))
        .limit(1);
      if (inv) {
        const cgstNum = Number(inv.cgstAmount);
        const sgstNum = Number(inv.sgstAmount);
        return ok(res, {
          subtotal: Number(inv.subtotal),
          gst: +(cgstNum + sgstNum).toFixed(2),
          cgst: cgstNum,
          sgst: sgstNum,
          grandTotal: Number(inv.grandTotal),
          balanceDue: Number(inv.balanceDue),
          totalPaid: Number(inv.totalPaid),
          invoiceNumber: inv.invoiceNumber,
          invoiceScope: inv.scope,
          alreadyInvoiced: true,
          // Echo the line items from the bound invoice for completeness —
          // useful if the modal wants to render them. We fetch them on
          // demand only when the caller needs them; for the quote summary
          // the totals above are enough.
          lineItems: [] as never[],
        });
      }
    }

    const remainingUnInvoicedRoomIds = allResRooms
      .filter((x) => !x.rr.invoiceId)
      .map((x) => x.room.id);
    const scopedCharges = selectChargesForScope({
      allCharges,
      scopeRoomIds: [roomId],
      remainingUnInvoicedRoomIds,
    });
    const roomNumberById = await buildRoomNumberMap(scopedRooms);
    const swapHopsByRowId = await buildSwapHopsMap(scopedRooms.map((x) => x.rr.id));
    const built = buildInvoice({
      reservation: {
        stayType: resv.stayType,
        durationHours: resv.durationHours,
        checkInDate: resv.checkInDate,
        checkOutDate: resv.checkOutDate,
        numNights: resv.numNights,
        gstRate: resv.gstRate,
        gstMode: resv.gstMode,
      },
      rooms: scopedRooms.map((x) => ({ ...x.rr, room: x.room })) as never,
      charges: scopedCharges,
      labelMap,
      roomNumberById,
      swapHopsByRowId,
    });

    // Advance allocation across the remaining un-invoiced rooms.
    //
    // The reservation's advance_paid is a lump sum collected before any
    // per-room invoices were issued. As each room checks out we owe it a
    // share of that advance — otherwise the modal asks staff to collect
    // the room's full grand_total even though the guest already paid an
    // advance. Split EQUALLY per remaining room (owner's preference —
    // easy to explain at the desk): ₹5,000 advance on 2 rooms → ₹2,500
    // each; on 4 rooms → ₹1,250 each. Capped at this room's own bill —
    // a cheap room can't absorb more than it owes; the unused portion
    // stays unallocated, and the next room's quote recomputes from
    // whatever advance is actually still orphaned, so amounts stay
    // consistent however the rooms check out. (The displayed share
    // never moves real money by itself — payment attachment at invoice
    // time is need-based.)
    //
    // We only count payments NOT already attached to a different invoice
    // as "available advance" — anything that's been redirected to a
    // sibling room's invoice via attachOrphanPaymentsAndRecompute is
    // off-limits to us.
    const reservationPayments = await db
      .select({
        amount: payments.amount,
        invoiceId: payments.invoiceId,
        status: payments.status,
        voided: payments.voided,
      })
      .from(payments)
      .where(eq(payments.reservationId, id));
    const availableAdvance = reservationPayments.reduce((sum, p) => {
      if (p.voided || p.status !== "received") return sum;
      // Orphan rows (NULL invoice) plus rows attached to invoices that
      // belong to THIS room are both available — the latter shouldn't
      // happen on the un-invoiced path, but it's harmless.
      if (p.invoiceId === null) return sum + Number(p.amount);
      return sum;
    }, 0);
    let advanceShare = 0;
    // Distinct rooms — a swapped room can have multiple segment rows
    // with the same room id, which would silently shrink every share.
    const remainingRoomCount = new Set(remainingUnInvoicedRoomIds).size;
    if (availableAdvance > 0.009 && remainingRoomCount > 0) {
      const equalShare = availableAdvance / remainingRoomCount;
      advanceShare = +Math.min(equalShare, built.grandTotal).toFixed(2);
    }

    return ok(res, {
      subtotal: built.subtotal,
      gst: built.totalGst,
      cgst: built.cgst,
      sgst: built.sgst,
      grandTotal: built.grandTotal,
      // What staff needs to collect now = bill minus this room's share
      // of the unallocated advance. Defaults to the full grand total
      // when no advance was paid (preserves legacy behaviour).
      balanceDue: +(built.grandTotal - advanceShare).toFixed(2),
      totalPaid: advanceShare,
      // Surfaced so the modal can show "Advance applied: ₹X" near the
      // bill summary, matching the design we agreed.
      advanceApplied: advanceShare,
      lineItems: built.lineItems,
      alreadyInvoiced: false,
    });
  },
);

// Check OUT a single room — and settle it. This endpoint does
// everything atomically:
//   1. If the room has no invoice yet, generate the per-room invoice
//      (same math as POST /:id/invoice with scope=room)
//   2. Record the payment against that invoice (if amount > 0)
//   3. Flip the reservation_room status, free the physical room,
//      create the housekeeping-clean task
//   4. Roll up the parent reservation if every room is now done
//
// Body (all optional except when balance > 0):
//   { skipInvoice?: boolean,  // default false; rarely used
//     paymentAmount?: number, // required when there's a balance
//     paymentMethod?: PaymentMethod,
//     paymentNotes?: string }
const perRoomCheckoutSchema = z.object({
  skipInvoice: z.boolean().optional(),
  paymentAmount: z.coerce.number().min(0).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  paymentNotes: z.string().max(500).optional(),
});

// Auto-consolidate per-room invoices into ONE combined invoice when a
// multi-room stay finishes via per-room checkout. Called at roll-up
// (the last room just checked out). Goal: every completed stay ends
// with a single combined tax invoice, from which per-room *bills* can
// be printed — instead of N separate per-room invoices and no combined
// one (the dead-end where the per-room-bill buttons can't appear).
//
// SAFETY: only runs when every live per-room invoice is FULLY PAID. A
// fully-paid set means consolidation is pure bookkeeping — void the
// equal paid per-room invoices, issue one combined invoice for the same
// total, move the payments onto it. No credit notes, no partial-payment
// edge cases, no money moved. If anything is unpaid/partial we leave the
// per-room invoices as they are (staff can still collect on them).
//
// Returns the new combined invoice number, or null if no consolidation
// happened. Must run inside the caller's transaction.
async function autoConsolidatePerRoomInvoices(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  reservationId: string,
  issuedBy: string,
): Promise<string | null> {
  const [resv] = await tx
    .select()
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .limit(1);
  if (!resv) return null;

  // Live, ordinary invoices on this reservation (exclude voided +
  // credit notes).
  const liveInvoices = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.reservationId, reservationId),
        ne(invoices.status, "voided"),
        eq(invoices.documentType, "invoice"),
      ),
    )
    .orderBy(asc(invoices.createdAt));

  // Need 2+ live PER-ROOM invoices to consolidate. If there's already a
  // combined one, or fewer than 2 room invoices, nothing to do.
  const roomScoped = liveInvoices.filter((i) => i.scope === "room");
  const hasCombined = liveInvoices.some((i) => i.scope === "combined");
  if (hasCombined || roomScoped.length < 2) return null;

  // Only consolidate when EVERY live invoice is fully paid — keeps this
  // a no-money bookkeeping merge (see SAFETY note above).
  const allFullyPaid = liveInvoices.every(
    (i) => Number(i.balanceDue) <= 0.009 && Number(i.totalPaid) > 0.009,
  );
  if (!allFullyPaid) return null;

  // Build the combined invoice across every non-cancelled room, exactly
  // like the manual combined-invoice path.
  const [allResRooms, allCharges, settings] = await Promise.all([
    tx
      .select({ rr: reservationRooms, room: rooms })
      .from(reservationRooms)
      .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
      .where(eq(reservationRooms.reservationId, reservationId)),
    tx.select().from(additionalCharges).where(eq(additionalCharges.reservationId, reservationId)),
    getSettings(),
  ]);
  const scopeRooms = allResRooms.filter((x) => x.rr.status !== "cancelled");
  if (scopeRooms.length < 2) return null;
  const labelMap = await buildRoomTypeLabelMap();
  const [booker] = await tx
    .select()
    .from(guests)
    .where(eq(guests.id, resv.guestId))
    .limit(1);
  if (!booker) return null;

  const roomNumberById = await buildRoomNumberMap(scopeRooms);
  const swapHopsByRowId = await buildSwapHopsMap(scopeRooms.map((x) => x.rr.id));
  const built = buildInvoice({
    reservation: {
      stayType: resv.stayType,
      durationHours: resv.durationHours,
      checkInDate: resv.checkInDate,
      checkOutDate: resv.checkOutDate,
      numNights: resv.numNights,
      gstRate: resv.gstRate,
      gstMode: resv.gstMode,
    },
    rooms: scopeRooms.map((x) => ({ ...x.rr, room: x.room })) as never,
    charges: allCharges,
    labelMap,
    roomNumberById,
    swapHopsByRowId,
  });
  const cgstRate = +(built.roomGstRate / 2).toFixed(2);
  const sgstRate = +(built.roomGstRate / 2).toFixed(2);
  const invoiceSeq = await nextInvoiceSequence(`SLDT-INV-%`, tx);
  const invNumber = invoiceNumber(settings.invoicePrefix, invoiceSeq);
  const replaced = roomScoped.map((i) => i.invoiceNumber).join(", ");
  const [combined] = await tx
    .insert(invoices)
    .values({
      invoiceNumber: invNumber,
      propertyId: resv.propertyId,
      reservationId,
      guestId: booker.id,
      hotelName: settings.hotelName,
      hotelAddress: settings.hotelAddress,
      hotelGstin: settings.hotelGstin,
      guestName: booker.fullName,
      guestAddress: booker.address ?? null,
      guestGstin: booker.gstin ?? null,
      subtotal: String(built.subtotal),
      cgstRate: String(cgstRate),
      cgstAmount: String(built.cgst),
      sgstRate: String(sgstRate),
      sgstAmount: String(built.sgst),
      grandTotal: String(built.grandTotal),
      walletCreditApplied: "0.00",
      totalPaid: "0.00",
      balanceDue: String(built.grandTotal),
      status: "issued",
      scope: "combined" as const,
      scopeRoomIds: scopeRooms.map((x) => x.room.id),
      issuedBy,
      notes: `Auto-consolidated from ${replaced} at checkout`,
    })
    .returning();
  await tx
    .insert(invoiceLineItems)
    .values(built.lineItems.map((li) => ({ invoiceId: combined!.id, ...li })));

  // Move the paid per-room invoices' payments onto the combined one,
  // void the per-room invoices, and relink every room to the combined.
  const roomInvoiceIds = roomScoped.map((i) => i.id);
  await tx
    .update(payments)
    .set({ invoiceId: combined!.id })
    .where(
      and(
        eq(payments.reservationId, reservationId),
        inArray(payments.invoiceId, roomInvoiceIds),
      ),
    );
  await tx
    .update(invoices)
    .set({
      status: "voided",
      voidedReason: `Consolidated into ${invNumber} at checkout`,
      voidedBy: issuedBy,
      balanceDue: "0.00",
      updatedAt: new Date(),
    })
    .where(inArray(invoices.id, roomInvoiceIds));
  await tx
    .update(reservationRooms)
    .set({ invoiceId: combined!.id })
    .where(eq(reservationRooms.reservationId, reservationId));

  // Recompute the combined invoice's cached totals from the payments now
  // attached to it.
  await recomputeInvoiceTotals(tx, reservationId);
  return invNumber;
}

router.post(
  "/:id/rooms/:roomId/check-out",
  requireAuth,
  requirePermission("check_out"),
  validate(perRoomCheckoutSchema),
  async (req, res) => {
    const { id, roomId } = req.params as { id: string; roomId: string };
    const input = req.body as z.infer<typeof perRoomCheckoutSchema>;

    const [resv] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    if (!resv) return fail(res, 404, "NOT_FOUND", "Reservation not found");

    const [rr] = await db
      .select()
      .from(reservationRooms)
      .where(and(eq(reservationRooms.reservationId, id), eq(reservationRooms.roomId, roomId)))
      .limit(1);
    if (!rr) return fail(res, 404, "ROOM_NOT_FOUND", "Room not in this reservation");
    if (rr.status !== "checked_in") {
      return fail(
        res,
        409,
        "NOT_CHECKED_IN",
        `Room is ${rr.status}, can only check out a checked_in room`,
      );
    }

    // Compute this room's bill via the same invoice builder used by
    // POST /:id/invoice. If a per-room invoice already exists for
    // this room we won't issue another; the balance comes from THAT
    // invoice's remaining unpaid amount.
    const [allResRooms, allCharges, settings] = await Promise.all([
      db
        .select({ rr: reservationRooms, room: rooms })
        .from(reservationRooms)
        .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
        .where(eq(reservationRooms.reservationId, id)),
      db.select().from(additionalCharges).where(eq(additionalCharges.reservationId, id)),
      getSettings(),
    ]);
    const scopedRooms = allResRooms.filter((x) => x.room.id === roomId);
    const labelMap = await buildRoomTypeLabelMap();
    const remainingUnInvoicedRoomIds = allResRooms
      .filter((x) => !x.rr.invoiceId)
      .map((x) => x.room.id);
    const scopedCharges = selectChargesForScope({
      allCharges,
      scopeRoomIds: [roomId],
      remainingUnInvoicedRoomIds,
    });
    const built = buildInvoice({
      reservation: {
        stayType: resv.stayType,
        durationHours: resv.durationHours,
        checkInDate: resv.checkInDate,
        checkOutDate: resv.checkOutDate,
        numNights: resv.numNights,
        gstRate: resv.gstRate,
        gstMode: resv.gstMode,
      },
      rooms: scopedRooms.map((x) => ({ ...x.rr, room: x.room })) as never,
      charges: scopedCharges,
      labelMap,
      roomNumberById: await buildRoomNumberMap(scopedRooms),
      swapHopsByRowId: await buildSwapHopsMap(scopedRooms.map((x) => x.rr.id)),
    });

    const willIssueInvoice = !rr.invoiceId && !input.skipInvoice;
    const payAmount = input.paymentAmount ?? 0;
    const grandTotal = built.grandTotal;

    // Advance allocation — mirror the quote endpoint. This room's share
    // of the unallocated advance reduces what we still need to collect
    // for this invoice. The advance payment rows themselves get
    // re-homed to the new invoice via attachOrphanPaymentsAndRecompute
    // at the end of the transaction.
    const reservationPayments = await db
      .select({
        amount: payments.amount,
        invoiceId: payments.invoiceId,
        status: payments.status,
        voided: payments.voided,
      })
      .from(payments)
      .where(eq(payments.reservationId, id));
    const availableAdvance = reservationPayments.reduce((sum, p) => {
      if (p.voided || p.status !== "received") return sum;
      if (p.invoiceId === null) return sum + Number(p.amount);
      return sum;
    }, 0);
    let advanceShare = 0;
    if (availableAdvance > 0.009 && willIssueInvoice && remainingUnInvoicedRoomIds.length > 0) {
      let denom = 0;
      for (const x of allResRooms) {
        if (x.rr.invoiceId) continue;
        const sibCharges = selectChargesForScope({
          allCharges,
          scopeRoomIds: [x.room.id],
          remainingUnInvoicedRoomIds,
        });
        const sibBuilt = buildInvoice({
          reservation: {
            stayType: resv.stayType,
            durationHours: resv.durationHours,
            checkInDate: resv.checkInDate,
            checkOutDate: resv.checkOutDate,
            numNights: resv.numNights,
            gstRate: resv.gstRate,
            gstMode: resv.gstMode,
          },
          rooms: [{ ...x.rr, room: x.room }] as never,
          charges: sibCharges,
          labelMap,
          roomNumberById: await buildRoomNumberMap([x]),
          swapHopsByRowId: await buildSwapHopsMap([x.rr.id]),
        });
        denom += sibBuilt.grandTotal;
      }
      if (denom > 0.009) {
        advanceShare = Math.min(
          +((availableAdvance * grandTotal) / denom).toFixed(2),
          grandTotal,
        );
      }
    }
    // Effective grand total still owed AFTER the advance share is
    // applied — that's what staff needs to collect.
    const owedAfterAdvance = +(grandTotal - advanceShare).toFixed(2);

    // If we're issuing the invoice fresh, the amount still owed after
    // advance has to be collected (or explicitly marked unpaid). If the
    // invoice was already issued, we let the operator decide the amount
    // (we don't introspect prior payments on that invoice here — that's
    // the standalone Record Payment flow).
    if (willIssueInvoice && owedAfterAdvance > 0.009) {
      if (payAmount <= 0.009) {
        return fail(
          res,
          400,
          "PAYMENT_REQUIRED",
          `Guest owes ₹${owedAfterAdvance.toFixed(2)} for this room (after ₹${advanceShare.toFixed(2)} advance share). Collect payment or mark unpaid.`,
        );
      }
      if (!input.paymentMethod) {
        return fail(res, 400, "PAYMENT_METHOD_REQUIRED", "Payment method is required");
      }
      if (input.paymentMethod === "unpaid" && !input.paymentNotes?.trim()) {
        return fail(res, 400, "NOTES_REQUIRED", "Notes are required when marking unpaid");
      }
    }

    // Per-room occupant is the guest of record on the invoice.
    const [billedTo] = await db.select().from(guests).where(eq(guests.id, rr.guestId)).limit(1);
    if (!billedTo) return fail(res, 500, "GUEST_MISSING", "Occupant guest not found");

    const cgstRate = +(built.roomGstRate / 2).toFixed(2);
    const sgstRate = +(built.roomGstRate / 2).toFixed(2);
    const isUnpaid = input.paymentMethod === "unpaid";
    const realPaid = isUnpaid ? 0 : payAmount;

    const now = new Date();
    let issuedInvoiceId: string | null = rr.invoiceId;
    let issuedInvoiceNumber: string | null = null;
    // Set when the final checkout merges per-room invoices into one
    // combined invoice (see autoConsolidatePerRoomInvoices).
    let consolidatedInvoiceNumber: string | null = null;

    await db.transaction(async (tx) => {
      // 1. Issue the per-room invoice if it doesn't exist yet. The
      //    advance share is baked into total_paid as cached state;
      //    the actual payments-row attribution happens later via
      //    attachOrphanPaymentsAndRecompute.
      if (willIssueInvoice) {
        const invoiceSeq = await nextInvoiceSequence(`SLDT-INV-%`, tx);
        const invNumber = invoiceNumber(settings.invoicePrefix, invoiceSeq);
        const collectedOnThisInv = +(advanceShare + realPaid).toFixed(2);
        const balanceOnThisInv = +(grandTotal - collectedOnThisInv).toFixed(2);
        const [inv] = await tx
          .insert(invoices)
          .values({
            invoiceNumber: invNumber,
            propertyId: resv.propertyId,
            reservationId: id,
            guestId: billedTo.id,
            hotelName: settings.hotelName,
            hotelAddress: settings.hotelAddress,
            hotelGstin: settings.hotelGstin,
            guestName: billedTo.fullName,
            guestAddress: billedTo.address ?? null,
            guestGstin: billedTo.gstin ?? null,
            subtotal: String(built.subtotal),
            cgstRate: String(cgstRate),
            cgstAmount: String(built.cgst),
            sgstRate: String(sgstRate),
            sgstAmount: String(built.sgst),
            grandTotal: String(grandTotal),
            walletCreditApplied: "0.00",
            totalPaid: String(collectedOnThisInv),
            balanceDue: String(balanceOnThisInv),
            status:
              balanceOnThisInv <= 0.009
                ? "paid"
                : collectedOnThisInv > 0
                  ? "partial"
                  : "issued",
            scope: "room" as const,
            scopeRoomIds: [roomId],
            issuedBy: req.user!.id,
          })
          .returning();
        issuedInvoiceId = inv!.id;
        issuedInvoiceNumber = inv!.invoiceNumber;
        await tx
          .insert(invoiceLineItems)
          .values(built.lineItems.map((li) => ({ invoiceId: inv!.id, ...li })));
      }

      // 2. Record the payment (always, when amount > 0). Tied to the
      //    newly-issued invoice OR the pre-existing one on the room.
      if (payAmount > 0.009 && input.paymentMethod) {
        const rcpNum = await generateReceiptNumber(tx);
        await tx.insert(payments).values({
          receiptNumber: rcpNum,
          propertyId: resv.propertyId,
          invoiceId: issuedInvoiceId,
          reservationId: id,
          amount: String(payAmount.toFixed(2)),
          paymentMethod: input.paymentMethod,
          status: isUnpaid ? "pending" : "received",
          receivedBy: req.user!.id,
          notes: input.paymentNotes ?? null,
        });
      }

      // 3. Flip the per-room row + link the invoice.
      await tx
        .update(reservationRooms)
        .set({
          status: "checked_out",
          checkedOutAt: now,
          checkedOutBy: req.user!.id,
          invoiceId: issuedInvoiceId,
        })
        .where(eq(reservationRooms.id, rr.id));

      // 4. Free the physical room → dirty so housekeeping picks it up.
      await tx
        .update(rooms)
        .set({ status: "dirty", updatedAt: now })
        .where(eq(rooms.id, roomId));

      // 5. Roll up the parent reservation. If every non-cancelled
      //    room is now checked_out, flip the reservation to
      //    checked_out and accumulate the per-room invoice totals
      //    into the reservation's balance_due.
      const siblings = await tx
        .select({ status: reservationRooms.status })
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, id));
      const stillActive = siblings.some(
        (s) => s.status === "confirmed" || s.status === "checked_in",
      );
      const reservationNowComplete = !stillActive && resv.status !== "checked_out";
      if (reservationNowComplete) {
        await tx
          .update(reservations)
          .set({
            status: "checked_out",
            checkedOutAt: now,
            checkedOutBy: req.user!.id,
            updatedAt: now,
          })
          .where(eq(reservations.id, id));
      }
      // Always recompute after a per-room checkout: a payment may have
      // just landed, the room's invoice may have just been issued, and
      // the reservation's overall balance needs to reflect both.
      //
      // We also relocate any orphan payment rows (the booking-time
      // advance, typically) onto the live invoices — distributing
      // proportionally, splitting rows where needed. This keeps the
      // per-invoice attribution honest as each room checks out one by
      // one: the first checkout takes its proportional advance share,
      // the second takes its share of whatever advance is still
      // orphaned, etc. Without this the invoice we just issued has the
      // advance baked into its total_paid cache but no actual payment
      // row pointing at it, and the next recompute would zero the
      // cache back out.
      if (issuedInvoiceId) {
        await attachOrphanPaymentsAndRecompute(tx, id, issuedInvoiceId);
      }
      // When the last room just checked out and the per-room invoices
      // are all fully paid, merge them into ONE combined invoice so the
      // completed stay carries a single tax invoice (per-room *bills*
      // print from it). Safe no-money bookkeeping; no-op otherwise.
      if (reservationNowComplete) {
        consolidatedInvoiceNumber = await autoConsolidatePerRoomInvoices(
          tx,
          id,
          req.user!.id,
        );
      }
      await recomputeReservationBalance(tx, id);
    });

    await logActivity({
      action: "reservation_room_check_out",
      entityType: "reservation_room",
      entityId: rr.id,
      description: `Room ${roomId} checked out from ${resv.reservationNumber}${issuedInvoiceNumber ? ` · invoice ${issuedInvoiceNumber}` : ""}${payAmount > 0 ? ` · ₹${payAmount.toFixed(2)} ${input.paymentMethod}` : ""}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        reservationId: id,
        roomId,
        invoiceId: issuedInvoiceId,
        paymentAmount: payAmount,
        paymentMethod: input.paymentMethod,
      },
    });
    await invalidateDashboard();
    return ok(res, {
      roomId,
      status: "checked_out" as const,
      invoiceId: issuedInvoiceId,
      invoiceNumber: issuedInvoiceNumber,
      // Present when this was the final room and per-room invoices were
      // merged into one combined invoice.
      consolidatedInvoiceNumber,
      grandTotal,
    });
  },
);

// Generate an invoice. scope='room' → bill for one specific room
// (charges with roomId targeting that room + a fair share of any
// reservation-wide charges when this invoice happens to cover the
// last remaining rooms). scope='combined' → one bill for the whole
// reservation, ignoring any per-room invoices already issued for
// charges (they wouldn't double-count because they have their own
// invoice_id link).
// Optional payment payload accepted on invoice issue. When present, the
// server inserts a payment row tied to the new invoice and adjusts
// totalPaid / balanceDue / status accordingly — saves a second round-trip
// when the front desk wants to settle the bill at the same moment the
// invoice is generated.
const issueInvoicePaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  paymentNotes: z.string().max(500).optional().nullable(),
});

const issueInvoiceSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("room"),
    roomId: z.string().uuid(),
    payment: issueInvoicePaymentSchema.optional(),
  }),
  z.object({
    scope: z.literal("combined"),
    // Optional subset of room IDs to combine. When omitted, every still-
    // un-invoiced room rolls into one invoice (legacy default). When
    // provided, only the listed rooms are billed — useful for "combine
    // these three of the five remaining rooms" workflows.
    roomIds: z.array(z.string().uuid()).min(1).optional(),
    payment: issueInvoicePaymentSchema.optional(),
  }),
]);
router.post(
  "/:id/invoice",
  requireAuth,
  requirePermission("check_out"),
  validate(issueInvoiceSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as z.infer<typeof issueInvoiceSchema>;

    const [resv] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    if (!resv) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    if (resv.status === "cancelled") {
      return fail(res, 409, "CANCELLED", "Cannot invoice a cancelled reservation");
    }

    // Load everything we need in parallel.
    const [allResRooms, allCharges, settings] = await Promise.all([
      db
        .select({ rr: reservationRooms, room: rooms })
        .from(reservationRooms)
        .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
        .where(eq(reservationRooms.reservationId, id)),
      db
        .select()
        .from(additionalCharges)
        .where(eq(additionalCharges.reservationId, id)),
      getSettings(),
    ]);

    // Determine in-scope rooms.
    let scopeRoomIds: string[];
    let scopedRooms: typeof allResRooms;
    if (input.scope === "room") {
      scopedRooms = allResRooms.filter((x) => x.room.id === input.roomId);
      if (!scopedRooms.length) {
        return fail(res, 404, "ROOM_NOT_FOUND", "Room not in this reservation");
      }
      if (scopedRooms[0]!.rr.invoiceId) {
        return fail(
          res,
          409,
          "ALREADY_INVOICED",
          "This room already has an invoice — void & reissue if you need to regenerate",
        );
      }
      scopeRoomIds = [input.roomId];
    } else {
      // Combined: only include rooms that DON'T already have a per-room
      // invoice. When the caller supplies an explicit roomIds list, narrow
      // further to that subset (after rejecting any IDs that aren't on
      // this reservation or are already invoiced).
      const uninvoiced = allResRooms.filter((x) => !x.rr.invoiceId);
      if (!uninvoiced.length) {
        return fail(
          res,
          409,
          "ALREADY_INVOICED",
          "Every room already has its own invoice — nothing left to combine",
        );
      }
      if (input.roomIds && input.roomIds.length > 0) {
        const requested = new Set(input.roomIds);
        const validUninvoicedIds = new Set(uninvoiced.map((x) => x.room.id));
        for (const id of input.roomIds) {
          if (!validUninvoicedIds.has(id)) {
            return fail(
              res,
              409,
              "INVALID_ROOM",
              "One or more selected rooms aren't billable (not on this reservation, or already invoiced)",
            );
          }
        }
        scopedRooms = uninvoiced.filter((x) => requested.has(x.room.id));
      } else {
        scopedRooms = uninvoiced;
      }
      scopeRoomIds = scopedRooms.map((x) => x.room.id);
    }

    // Charges in scope (see invoiceBuilder docstring).
    const remainingUnInvoicedRoomIds = allResRooms
      .filter((x) => !x.rr.invoiceId && !scopeRoomIds.includes(x.room.id))
      .map((x) => x.room.id);
    // Plus our own scope rooms (they're "remaining" pre-issue).
    const trulyRemaining = [...new Set([...scopeRoomIds, ...remainingUnInvoicedRoomIds])];
    const scopedCharges = selectChargesForScope({
      allCharges,
      scopeRoomIds,
      remainingUnInvoicedRoomIds: trulyRemaining,
    });

    const labelMap = await buildRoomTypeLabelMap();
    const built = buildInvoice({
      reservation: {
        stayType: resv.stayType,
        durationHours: resv.durationHours,
        checkInDate: resv.checkInDate,
        checkOutDate: resv.checkOutDate,
        numNights: resv.numNights,
        gstRate: resv.gstRate,
        gstMode: resv.gstMode,
      },
      rooms: scopedRooms.map((x) => ({ ...x.rr, room: x.room })) as never,
      charges: scopedCharges,
      labelMap,
      roomNumberById: await buildRoomNumberMap(scopedRooms),
      swapHopsByRowId: await buildSwapHopsMap(scopedRooms.map((x) => x.rr.id)),
    });

    // Per-room invoice has its own occupant as the guest-of-record;
    // combined uses the booker (resv.guestId).
    const billedToGuestId =
      input.scope === "room" ? scopedRooms[0]!.rr.guestId : resv.guestId;
    const [billedTo] = await db
      .select()
      .from(guests)
      .where(eq(guests.id, billedToGuestId))
      .limit(1);
    if (!billedTo) {
      return fail(res, 500, "GUEST_MISSING", "Billed-to guest not found");
    }

    const cgstRate = +(built.roomGstRate / 2).toFixed(2);
    const sgstRate = +(built.roomGstRate / 2).toFixed(2);
    let invNumber = "";

    // Optional same-shot payment. Capped at the invoice total (paying
    // more would imply an overpay refund that this endpoint doesn't
    // handle — staff can refund via the check-out flow).
    const paymentAmount = input.payment?.amount ?? 0;
    if (paymentAmount > built.grandTotal + 0.009) {
      return fail(
        res,
        400,
        "PAYMENT_EXCEEDS_TOTAL",
        `Payment ₹${paymentAmount.toFixed(2)} exceeds invoice total ₹${built.grandTotal.toFixed(2)}.`,
      );
    }
    const walletCreditOnInvoice =
      input.scope === "combined" ? Number(resv.walletCreditApplied) : 0;
    const collectedOnInvoice = +(paymentAmount + walletCreditOnInvoice).toFixed(2);
    const invoiceBalance = +(built.grandTotal - collectedOnInvoice).toFixed(2);
    const invoiceStatus: "paid" | "partial" | "issued" =
      invoiceBalance <= 0.009
        ? "paid"
        : collectedOnInvoice > 0.009
          ? "partial"
          : "issued";

    const created = await db.transaction(async (tx) => {
      const invoiceSeq = await nextInvoiceSequence(`SLDT-INV-%`, tx);
      invNumber = invoiceNumber(settings.invoicePrefix, invoiceSeq);
      const [inv] = await tx
        .insert(invoices)
        .values({
          invoiceNumber: invNumber,
          propertyId: resv.propertyId,
          reservationId: id,
          guestId: billedToGuestId,
          hotelName: settings.hotelName,
          hotelAddress: settings.hotelAddress,
          hotelGstin: settings.hotelGstin,
          guestName: billedTo.fullName,
          guestAddress: billedTo.address ?? null,
          guestGstin: billedTo.gstin ?? null,
          subtotal: String(built.subtotal),
          cgstRate: String(cgstRate),
          cgstAmount: String(built.cgst),
          sgstRate: String(sgstRate),
          sgstAmount: String(built.sgst),
          grandTotal: String(built.grandTotal),
          // Per-room invoices don't absorb wallet credit by default
          // (the booker holds the wallet, not the per-room occupant).
          // Combined invoice carries any applied credit through.
          walletCreditApplied: String(walletCreditOnInvoice.toFixed(2)),
          totalPaid: String(collectedOnInvoice),
          balanceDue: String(Math.max(0, invoiceBalance)),
          status: invoiceStatus,
          // Honour the requested scope, but downgrade a 1-room "combined"
          // to "room" so the UI doesn't tag a single-room bill as combined.
          scope:
            input.scope === "room" || scopeRoomIds.length <= 1
              ? ("room" as const)
              : ("combined" as const),
          scopeRoomIds,
          issuedBy: req.user!.id,
        })
        .returning();

      await tx
        .insert(invoiceLineItems)
        .values(built.lineItems.map((li) => ({ invoiceId: inv!.id, ...li })));

      // Link the in-scope reservation_rooms to this new invoice.
      await tx
        .update(reservationRooms)
        .set({ invoiceId: inv!.id })
        .where(
          and(
            eq(reservationRooms.reservationId, id),
            inArray(reservationRooms.roomId, scopeRoomIds),
          ),
        );

      if (paymentAmount > 0.009 && input.payment) {
        const rcpNum = await generateReceiptNumber(tx);
        await tx.insert(payments).values({
          receiptNumber: rcpNum,
          propertyId: resv.propertyId,
          invoiceId: inv!.id,
          reservationId: id,
          amount: String(paymentAmount.toFixed(2)),
          paymentMethod: input.payment.paymentMethod,
          status: "received",
          receivedBy: req.user!.id,
          notes: input.payment.paymentNotes ?? null,
        });
      }

      // After issuing this invoice, also re-link any orphan payments
      // (those collected before any invoice existed — typically the
      // "Collected at check-out of SLDT-RES-XXXX" forward-credit) to
      // this fresh invoice, then recompute. Without this, a forward-
      // credited advance would never land on the bill it's meant for.
      await attachOrphanPaymentsAndRecompute(tx, id, inv!.id);

      // Re-read the invoice AFTER the recompute: attachOrphan… updates
      // total_paid / balance_due / status in place when it folds the
      // booking advance onto this bill. The `inv` from the insert above
      // still carries the pre-recompute balance (= grandTotal, because
      // no inline payment was supplied). Returning that stale row made
      // the client think money was still owed and pop the collect-
      // payment modal — letting staff record a SECOND payment for an
      // invoice the advance had already settled (the RES-0005 double
      // -collect). Return the fresh row so the balance is truthful.
      const [fresh] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, inv!.id))
        .limit(1);
      return fresh ?? inv!;
    });

    await logActivity({
      action: "invoice_issued",
      entityType: "invoice",
      entityId: created.id,
      description: `${invNumber} issued (scope=${input.scope}${input.scope === "room" ? ` room=${input.roomId}` : ""}) for ${resv.reservationNumber}${paymentAmount > 0 ? ` · ₹${paymentAmount.toFixed(2)} ${input.payment!.paymentMethod}` : ""}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        scope: input.scope,
        scopeRoomIds,
        grandTotal: built.grandTotal,
        paymentAmount,
        paymentMethod: input.payment?.paymentMethod,
      },
    });
    await invalidateDashboard();
    return ok(res, created);
  },
);

// Convert this reservation's invoice layout between per-room and
// combined. Used when staff realises mid-stay (or after checkout)
// that the original choice was wrong — corp guest wants one bill,
// or individual occupants want separate bills.
//
// Algorithm is the same shape both ways:
//   1. Validate the current shape is the OTHER mode (no-op
//      conversion is rejected).
//   2. Void the live invoice(s); set status='voided' + a credit-note
//      style reason naming the successor invoice number(s).
//   3. Detach payments from the voided invoices (NULL out invoice_id)
//      so they're orphan again.
//   4. Issue the new invoice(s) via buildInvoice — same math the
//      original checkout used, so totals reconcile.
//   5. Re-link each reservation_room.invoice_id to its new invoice.
//   6. attachOrphanPaymentsAndRecompute redistributes the detached
//      payments across the new shape (proportional split, room hint
//      preferred), then recompute reservation totals.
//
// Works from ANY starting shape — all per-room, all combined, or a
// MIXED reservation (some rooms invoiced per-room, others on a combined
// invoice). The reissue always rebuilds the chosen shape across every
// non-cancelled room, so a mixed state normalises to a clean uniform
// one. Refused only when there's nothing meaningful to do, or when
// money has been recorded against a live invoice (see guard below).
//
// MONEY GUARD: reissue voids the live invoices. Voiding an invoice that
// already has a payment recorded against it means cancelling a tax
// document the guest has partly/fully settled — that needs a credit
// note, not a silent void. So we block reissue when ANY live invoice
// has totalPaid > 0 (partial OR paid). Reorganise bills BEFORE
// collecting; once money is on a bill, void + credit-note manually.
router.post(
  "/:id/convert-invoices",
  requireAuth,
  requirePermission("reissue_invoices"),
  validate(convertInvoicesSchema),
  async (req, res) => {
    const id = req.params.id!;
    const input = req.body as z.infer<typeof convertInvoicesSchema>;

    const [resv] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    if (!resv) return fail(res, 404, "NOT_FOUND", "Reservation not found");

    // Live ORDINARY invoices only — exclude voided ones and credit
    // notes. A credit note is a reversal document (negative totals,
    // never holds a payment); pulling them into this set corrupted the
    // "all fully paid?" classification and let a second reissue
    // credit-note its own credit notes, double-billing the stay.
    const allLiveDocs = await db
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.reservationId, id), ne(invoices.status, "voided")),
      )
      .orderBy(asc(invoices.createdAt));
    // Originals already reversed by a live credit note are spent — they
    // must not be reissued again.
    const reversedOriginalIds = new Set(
      allLiveDocs
        .filter((i) => i.documentType === "credit_note" && i.creditNoteFor)
        .map((i) => i.creditNoteFor as string),
    );
    const liveInvoices = allLiveDocs.filter(
      (i) =>
        i.documentType !== "credit_note" && !reversedOriginalIds.has(i.id),
    );

    if (liveInvoices.length === 0) {
      return fail(
        res,
        409,
        "NO_INVOICES",
        "No live invoices to convert. Issue invoices first via the normal checkout flow.",
      );
    }

    // Classify the reissue by how settled the live invoices are:
    //
    //   • useCreditNotes = false (void path): no live invoice has any
    //     payment. Safe to simply void + reissue.
    //   • useCreditNotes = true (credit-note path): every live invoice is
    //     FULLY paid (balance ~0). The originals are reversed with GST
    //     credit notes (kept on file, not voided), the payment is moved
    //     to the new invoices, and the new ones come out paid. This is
    //     the "guest already paid a combined bill, now needs per-room
    //     GST invoices for their office" case.
    //
    // Anything in between — a PARTIALLY paid invoice, or a mix of paid
    // and unpaid live invoices — is refused: those need the desk to
    // either finish collecting or refund first, because a credit note
    // reverses a settled document, not a half-paid one.
    const anyPayment = liveInvoices.some((i) => Number(i.totalPaid) > 0.009);
    const allFullyPaid = liveInvoices.every(
      (i) => Number(i.balanceDue) <= 0.009 && Number(i.totalPaid) > 0.009,
    );
    const useCreditNotes = anyPayment;
    if (anyPayment && !allFullyPaid) {
      return fail(
        res,
        409,
        "INVOICE_PARTIALLY_PAID",
        "Some invoices are partly paid. Finish collecting (or refund) so every bill is fully settled, then reissue with credit notes — a credit note can only reverse a fully-settled invoice.",
      );
    }

    // Integrity guard for the credit-note path. The reissue detaches the
    // payments on `liveInvoices` and reattaches them to the new ones, so
    // those invoices must hold ALL of the reservation's received money.
    // If money is sitting on an invoice NOT in this set (a stray bill
    // from an earlier botched reissue), proceeding would silently move
    // the wrong amount and double-bill the stay — exactly the tangle we
    // just repaired. Refuse loudly instead.
    if (useCreditNotes) {
      const liveIds = liveInvoices.map((i) => i.id);
      const [resvPaid] = await db
        .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text` })
        .from(payments)
        .where(
          and(
            eq(payments.reservationId, id),
            eq(payments.voided, false),
            eq(payments.status, "received"),
          ),
        );
      const [onLive] = await db
        .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)::text` })
        .from(payments)
        .where(
          and(
            eq(payments.reservationId, id),
            eq(payments.voided, false),
            eq(payments.status, "received"),
            liveIds.length > 0
              ? inArray(payments.invoiceId, liveIds)
              : sql`false`,
          ),
        );
      if (Math.abs(Number(resvPaid?.total ?? 0) - Number(onLive?.total ?? 0)) > 0.009) {
        return fail(
          res,
          409,
          "PAYMENT_NOT_ON_LIVE_INVOICES",
          "Some of this reservation's payments are on an invoice that isn't part of this reissue. Resolve the invoices so all paid money sits on the current bills before reissuing.",
        );
      }
    }

    // Count distinct non-cancelled rooms that WOULD be billed. With
    // fewer than 2, per-room and combined are identical — nothing to
    // convert either way.
    const billableRoomCount = new Set(
      (
        await db
          .select({ roomId: reservationRooms.roomId })
          .from(reservationRooms)
          .where(
            and(
              eq(reservationRooms.reservationId, id),
              ne(reservationRooms.status, "cancelled"),
            ),
          )
      ).map((x) => x.roomId),
    ).size;
    if (billableRoomCount < 2) {
      return fail(
        res,
        409,
        "NOT_MULTI_ROOM",
        "Reissue needs at least 2 rooms — a single-room booking has only one possible bill.",
      );
    }

    // No-op guard: refuse when the reservation is ALREADY in the target
    // shape and uniform (so combine→combine / split→split do nothing).
    // A mixed state is never uniform, so it always passes — that's the
    // case the old rigid gates couldn't handle.
    if (input.mode === "combined") {
      const allCombined = liveInvoices.every((i) => i.scope === "combined");
      if (allCombined && liveInvoices.length === 1) {
        return fail(
          res,
          409,
          "ALREADY_COMBINED",
          "This reservation is already on a single combined invoice.",
        );
      }
    } else {
      const allRoomScoped = liveInvoices.every((i) => i.scope === "room");
      if (allRoomScoped) {
        return fail(
          res,
          409,
          "ALREADY_PER_ROOM",
          "Every room already has its own per-room invoice.",
        );
      }
    }

    // Gather the data buildInvoice needs. Mirrors the rest of the
    // checkout endpoints so the new invoices match the originals.
    const [allResRooms, allCharges, settings] = await Promise.all([
      db
        .select({ rr: reservationRooms, room: rooms })
        .from(reservationRooms)
        .innerJoin(rooms, eq(rooms.id, reservationRooms.roomId))
        .where(eq(reservationRooms.reservationId, id)),
      db
        .select()
        .from(additionalCharges)
        .where(eq(additionalCharges.reservationId, id)),
      getSettings(),
    ]);
    const labelMap = await buildRoomTypeLabelMap();

    // Use the booker as the bill-to for the new combined invoice; for
    // per-room we use each room's occupant (matching the original
    // per-room behaviour).
    const [booker] = await db
      .select()
      .from(guests)
      .where(eq(guests.id, resv.guestId))
      .limit(1);
    if (!booker) {
      return fail(res, 500, "GUEST_MISSING", "Booker guest not found");
    }

    const newInvoiceNumbers: string[] = [];
    // The originals being replaced — voided (void path) or reversed by a
    // credit note (credit-note path).
    const replacedInvoiceNumbers = liveInvoices.map((i) => i.invoiceNumber);

    await db.transaction(async (tx) => {
      // 1. Detach payments from the voided invoices so they're orphan
      //    and ready for redistribution against the new invoices.
      const liveInvoiceIds = liveInvoices.map((i) => i.id);
      await tx
        .update(payments)
        .set({ invoiceId: null })
        .where(
          and(
            eq(payments.reservationId, id),
            inArray(payments.invoiceId, liveInvoiceIds),
          ),
        );

      // 2. Build + insert the new invoice(s) FIRST so we know the
      //    successor numbers to cite in the void reason.
      const issuedInvoices: { id: string; invoiceNumber: string }[] = [];

      if (input.mode === "combined") {
        // One combined invoice covering every non-cancelled room.
        const scopeRooms = allResRooms.filter(
          (x) => x.rr.status !== "cancelled",
        );
        const scopeRoomIds = scopeRooms.map((x) => x.room.id);
        const built = buildInvoice({
          reservation: {
            stayType: resv.stayType,
            durationHours: resv.durationHours,
            checkInDate: resv.checkInDate,
            checkOutDate: resv.checkOutDate,
            numNights: resv.numNights,
            gstRate: resv.gstRate,
            gstMode: resv.gstMode,
          },
          rooms: scopeRooms.map((x) => ({ ...x.rr, room: x.room })) as never,
          charges: allCharges,
          labelMap,
          roomNumberById: await buildRoomNumberMap(scopeRooms),
          swapHopsByRowId: await buildSwapHopsMap(scopeRooms.map((x) => x.rr.id)),
        });
        const cgstRate = +(built.roomGstRate / 2).toFixed(2);
        const sgstRate = +(built.roomGstRate / 2).toFixed(2);
        const invoiceSeq = await nextInvoiceSequence(`SLDT-INV-%`, tx);
        const invNumber = invoiceNumber(settings.invoicePrefix, invoiceSeq);
        const [inv] = await tx
          .insert(invoices)
          .values({
            invoiceNumber: invNumber,
            propertyId: resv.propertyId,
            reservationId: id,
            guestId: booker.id,
            hotelName: settings.hotelName,
            hotelAddress: settings.hotelAddress,
            hotelGstin: settings.hotelGstin,
            guestName: booker.fullName,
            guestAddress: booker.address ?? null,
            guestGstin: booker.gstin ?? null,
            subtotal: String(built.subtotal),
            cgstRate: String(cgstRate),
            cgstAmount: String(built.cgst),
            sgstRate: String(sgstRate),
            sgstAmount: String(built.sgst),
            grandTotal: String(built.grandTotal),
            walletCreditApplied: "0.00",
            totalPaid: "0.00",
            balanceDue: String(built.grandTotal),
            status: "issued",
            scope: "combined" as const,
            scopeRoomIds,
            issuedBy: req.user!.id,
            notes: `Consolidated from ${replacedInvoiceNumbers.join(", ")}`,
          })
          .returning();
        await tx
          .insert(invoiceLineItems)
          .values(built.lineItems.map((li) => ({ invoiceId: inv!.id, ...li })));
        await tx
          .update(reservationRooms)
          .set({ invoiceId: inv!.id })
          .where(
            and(
              eq(reservationRooms.reservationId, id),
              inArray(reservationRooms.roomId, scopeRoomIds),
            ),
          );
        issuedInvoices.push({ id: inv!.id, invoiceNumber: invNumber });
        newInvoiceNumbers.push(invNumber);
      } else {
        // mode === "per_room": one invoice per non-cancelled room.
        const scopeRooms = allResRooms.filter(
          (x) => x.rr.status !== "cancelled",
        );
        const allUnInvoicedAfterReissue = scopeRooms.map((x) => x.room.id);
        for (const x of scopeRooms) {
          const scopedCharges = selectChargesForScope({
            allCharges,
            scopeRoomIds: [x.room.id],
            remainingUnInvoicedRoomIds: allUnInvoicedAfterReissue,
          });
          const built = buildInvoice({
            reservation: {
              stayType: resv.stayType,
              durationHours: resv.durationHours,
              checkInDate: resv.checkInDate,
              checkOutDate: resv.checkOutDate,
              numNights: resv.numNights,
              gstRate: resv.gstRate,
              gstMode: resv.gstMode,
            },
            rooms: [{ ...x.rr, room: x.room }] as never,
            charges: scopedCharges,
            labelMap,
            roomNumberById: await buildRoomNumberMap([x]),
            swapHopsByRowId: await buildSwapHopsMap([x.rr.id]),
          });
          const cgstRate = +(built.roomGstRate / 2).toFixed(2);
          const sgstRate = +(built.roomGstRate / 2).toFixed(2);
          const [occupant] = await tx
            .select()
            .from(guests)
            .where(eq(guests.id, x.rr.guestId))
            .limit(1);
          const billedTo = occupant ?? booker;
          const invoiceSeq = await nextInvoiceSequence(`SLDT-INV-%`, tx);
          const invNumber = invoiceNumber(
            settings.invoicePrefix,
            invoiceSeq,
          );
          const [inv] = await tx
            .insert(invoices)
            .values({
              invoiceNumber: invNumber,
              propertyId: resv.propertyId,
              reservationId: id,
              guestId: billedTo.id,
              hotelName: settings.hotelName,
              hotelAddress: settings.hotelAddress,
              hotelGstin: settings.hotelGstin,
              guestName: billedTo.fullName,
              guestAddress: billedTo.address ?? null,
              guestGstin: billedTo.gstin ?? null,
              subtotal: String(built.subtotal),
              cgstRate: String(cgstRate),
              cgstAmount: String(built.cgst),
              sgstRate: String(sgstRate),
              sgstAmount: String(built.sgst),
              grandTotal: String(built.grandTotal),
              walletCreditApplied: "0.00",
              totalPaid: "0.00",
              balanceDue: String(built.grandTotal),
              status: "issued",
              scope: "room" as const,
              scopeRoomIds: [x.room.id],
              issuedBy: req.user!.id,
              notes: `Split from ${replacedInvoiceNumbers.join(", ")}`,
            })
            .returning();
          await tx
            .insert(invoiceLineItems)
            .values(
              built.lineItems.map((li) => ({ invoiceId: inv!.id, ...li })),
            );
          await tx
            .update(reservationRooms)
            .set({ invoiceId: inv!.id })
            .where(eq(reservationRooms.id, x.rr.id));
          issuedInvoices.push({ id: inv!.id, invoiceNumber: invNumber });
          newInvoiceNumbers.push(invNumber);
        }
      }

      // 3. Reverse the originals AFTER the new ones are issued, so the
      //    successor numbers can be cited.
      const successorList = newInvoiceNumbers.join(", ");
      if (!useCreditNotes) {
        // Void path — no money on the originals, just mark them voided.
        for (const old of liveInvoices) {
          await tx
            .update(invoices)
            .set({
              status: "voided",
              voidedReason: `Reissued as ${successorList}`,
              voidedBy: req.user!.id,
              balanceDue: "0.00",
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, old.id));
        }
      } else {
        // Credit-note path — the originals are PAID and stay valid on
        // file. Issue a GST credit note reversing each one (negative
        // money columns, same hotel/guest snapshot, document_type =
        // credit_note, credit_note_for = the original). The original's
        // status stays 'paid'; the credit note nets it on the GST
        // return. The payment already detached in step 1 reattaches to
        // the new invoices below.
        for (const old of liveInvoices) {
          const cnSeq = await nextCreditNoteSequence(tx);
          const cnNumber = creditNoteNumber(cnSeq);
          const [cnRow] = await tx
            .insert(invoices)
            .values({
              invoiceNumber: cnNumber,
              propertyId: old.propertyId,
              reservationId: id,
              guestId: old.guestId,
              hotelName: old.hotelName,
              hotelAddress: old.hotelAddress,
              hotelGstin: old.hotelGstin,
              guestName: old.guestName,
              guestAddress: old.guestAddress,
              guestGstin: old.guestGstin,
              // Negative mirrors so the credit note nets against the
              // original on every money surface.
              subtotal: String(-Number(old.subtotal)),
              cgstRate: old.cgstRate,
              cgstAmount: String(-Number(old.cgstAmount)),
              sgstRate: old.sgstRate,
              sgstAmount: String(-Number(old.sgstAmount)),
              grandTotal: String(-Number(old.grandTotal)),
              walletCreditApplied: "0.00",
              totalPaid: "0.00",
              balanceDue: "0.00",
              status: "issued",
              documentType: "credit_note",
              creditNoteFor: old.id,
              scope: old.scope,
              scopeRoomIds: old.scopeRoomIds,
              issuedBy: req.user!.id,
              notes: `Credit note reversing ${old.invoiceNumber} — reissued as ${successorList}`,
            })
            .returning();
          // Mirror the original's line items as negatives so the credit
          // note PDF itemises exactly what it reverses.
          const oldItems = await tx
            .select()
            .from(invoiceLineItems)
            .where(eq(invoiceLineItems.invoiceId, old.id));
          if (oldItems.length > 0) {
            await tx.insert(invoiceLineItems).values(
              oldItems.map((li) => ({
                invoiceId: cnRow!.id,
                description: li.description,
                sacCode: li.sacCode,
                quantity: li.quantity,
                rate: String(-Number(li.rate)),
                amount: String(-Number(li.amount)),
                gstRate: li.gstRate,
                gstAmount: String(-Number(li.gstAmount)),
                itemType: li.itemType,
              })),
            );
          }
          // Stamp the original so the UI can pair it with its credit note
          // and collapse the reversed pair behind a toggle.
          await tx
            .update(invoices)
            .set({
              notes: old.notes
                ? `${old.notes} · Reversed by ${cnNumber}; reissued as ${successorList}`
                : `Reversed by ${cnNumber}; reissued as ${successorList}`,
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, old.id));
        }
      }

      // 4. Redistribute the now-orphan payments across the new
      //    invoices. attachOrphanPaymentsAndRecompute handles the
      //    proportional split, room hints, and any overflow
      //    splitting into multiple payment rows.
      const fallbackInvoiceId =
        issuedInvoices[issuedInvoices.length - 1]!.id;
      await attachOrphanPaymentsAndRecompute(tx, id, fallbackInvoiceId);
      await recomputeReservationBalance(tx, id);
    });

    await logActivity({
      action: "reservation_invoice_convert",
      entityType: "reservation",
      entityId: id,
      description:
        `${resv.reservationNumber}: invoices reissued as ${input.mode} — ` +
        `${useCreditNotes ? "credit-noted" : "voided"} ${replacedInvoiceNumbers.join(", ")}, issued ${newInvoiceNumbers.join(", ")}`,
      performedBy: req.user!.id,
      ipAddress: req.ip,
      metadata: {
        mode: input.mode,
        method: useCreditNotes ? "credit_note" : "void",
        replacedInvoiceNumbers,
        newInvoiceNumbers,
      },
    });
    await invalidateDashboard();
    return ok(res, {
      mode: input.mode,
      method: useCreditNotes ? "credit_note" : "void",
      // Back-compat: the web onSuccess reads voidedInvoiceNumbers.
      voidedInvoiceNumbers: replacedInvoiceNumbers,
      replacedInvoiceNumbers,
      newInvoiceNumbers,
    });
  },
);

export default router;

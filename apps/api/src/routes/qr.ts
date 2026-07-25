// Public QR surface (unauthenticated). Two entry points, both behind
// permanent opaque tokens printed as QR codes:
//
//   In-room sticker  →  /public/qr/room/:token
//     Vacant room: hotel brochure only (nothing sensitive).
//     Occupied room: guest proves they're the current guest (phone last-4)
//     → unlock key (HMAC, dies at checkout) → WiFi + service requests.
//     Browser geolocation, when granted, is logged as an advisory distance
//     to the hotel pin — it never hard-blocks (GPS is trivially spoofed and
//     indoor accuracy is worse than a hotel's footprint).
//
//   Front-desk master QR  →  /public/qr/hotel/:token
//     Catalog of rooms free TONIGHT → OTP-verified self-booking. Arrives as
//     status='hold' (non-blocking) with hold_expires_at; the front desk
//     confirms payment in person and flips it to confirmed, or it expires.
//
// Tenant isolation: every query below is scoped to the property resolved
// FROM the token — nothing crosses hotels, nothing enumerable.
//
// No logActivity here: activity_log.performed_by is a NOT NULL staff
// profile, and these actors are guests. The audit trail for this surface is
// the notification stream + structured logs.

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  qrBookSchema,
  qrBookSendOtpSchema,
  qrRequestSchema,
  qrUnlockSchema,
  type QrBookInput,
  type QrRequestInput,
  type QrUnlockInput,
} from "@stayvia/shared";
import { addDays, format, parseISO } from "date-fns";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { amenities, roomAmenities, roomImages } from "../db/schema/amenities.js";
import { guests } from "../db/schema/guests.js";
import { otps } from "../db/schema/otps.js";
import { properties } from "../db/schema/properties.js";
import { reservationRooms, reservations } from "../db/schema/reservations.js";
import { rooms } from "../db/schema/rooms.js";
import { roomTypes, settings } from "../db/schema/settings.js";
import { findAvailableRooms } from "../lib/availability.js";
import { encrypt, idProofHash, last4 } from "../lib/crypto.js";
import { calcGstBreakdown, getGstRate } from "../lib/gst.js";
import { logger } from "../lib/logger.js";
import { dispatchNotification, notifyGuestSms } from "../lib/notify.js";
import { nextDocNumber, reservationNumber } from "../lib/numbers.js";
import { expiresAt, generateOtp, hashOtp, maskTarget } from "../lib/otp.js";
import { propertyToday } from "../lib/propertyTime.js";
import { fail, ok } from "../lib/response.js";
import { qrReadLimiter, qrUnlockLimiter, qrWriteLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// ---------------------------------------------------------------- helpers

async function loadRoomByToken(token: string | undefined) {
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return null;
  const rows = await db
    .select({ room: rooms, property: properties, propertySettings: settings })
    .from(rooms)
    .innerJoin(properties, eq(rooms.propertyId, properties.id))
    .innerJoin(settings, eq(settings.propertyId, properties.id))
    .where(eq(rooms.qrToken, token))
    .limit(1);
  return rows[0] ?? null;
}

async function loadHotelByToken(token: string | undefined) {
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return null;
  const rows = await db
    .select({ property: properties, propertySettings: settings })
    .from(properties)
    .innerJoin(settings, eq(settings.propertyId, properties.id))
    .where(eq(properties.qrToken, token))
    .limit(1);
  return rows[0] ?? null;
}

// The active (checked-in, currently effective) occupancy of a room, if any.
async function activeStayForRoom(propertyId: string, roomId: string) {
  const today = propertyToday();
  const rows = await db
    .select({
      reservationId: reservations.id,
      reservationNumber: reservations.reservationNumber,
      checkOutDate: reservations.checkOutDate,
      guestId: reservations.guestId,
      guestName: guests.fullName,
      guestPhone: guests.phone,
    })
    .from(reservationRooms)
    .innerJoin(reservations, eq(reservationRooms.reservationId, reservations.id))
    .innerJoin(guests, eq(reservations.guestId, guests.id))
    .where(
      and(
        eq(reservations.propertyId, propertyId),
        eq(reservationRooms.roomId, roomId),
        eq(reservations.status, "checked_in"),
        eq(reservationRooms.status, "checked_in"),
        // Segment live today (checkout-day segments included — same rule as
        // the dashboard occupancy fix).
        sql`(${reservationRooms.effectiveTo} IS NULL
             OR ${reservationRooms.effectiveTo} >= ${today}
             OR ${reservationRooms.effectiveTo} >= ${reservations.checkOutDate})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// Unlock key: HMAC over (roomId, reservationId, expiry). Self-contained —
// no session storage; dies shortly after the stay's checkout date.
function unlockSecret(): string {
  return `qr-unlock:${env.SUPABASE_JWT_SECRET}`;
}

function mintUnlockKey(roomId: string, reservationId: string, expUnix: number): string {
  const payload = `${roomId}.${reservationId}.${expUnix}`;
  const sig = createHmac("sha256", unlockSecret()).update(payload).digest("hex").slice(0, 32);
  return Buffer.from(payload).toString("base64url") + "." + sig;
}

function verifyUnlockKey(key: string, roomId: string): { reservationId: string } | null {
  const dot = key.lastIndexOf(".");
  if (dot < 0) return null;
  const [b64, sig] = [key.slice(0, dot), key.slice(dot + 1)];
  let payload: string;
  try {
    payload = Buffer.from(b64, "base64url").toString();
  } catch {
    return null;
  }
  const expect = createHmac("sha256", unlockSecret()).update(payload).digest("hex").slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  const [rid, resId, expStr] = parts as [string, string, string];
  if (rid !== roomId) return null;
  if (Number(expStr) * 1000 < Date.now()) return null;
  return { reservationId: resId };
}

// Haversine distance in metres — advisory geofence logging only.
function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

type HotelCtx = {
  property: typeof properties.$inferSelect;
  propertySettings: typeof settings.$inferSelect;
};

// Rooms carrying a LIVE unconfirmed hold overlapping [checkIn, checkOut).
// Staff availability deliberately ignores holds (they must never starve the
// desk), but the DB exclusion constraint (0011) counts them — so the public
// catalog has to subtract them or two phones can pick the same room and the
// second one hits a constraint error instead of a readable answer.
async function heldRoomIds(
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ roomId: reservationRooms.roomId })
    .from(reservationRooms)
    .innerJoin(reservations, eq(reservationRooms.reservationId, reservations.id))
    .where(
      and(
        eq(reservations.propertyId, propertyId),
        eq(reservations.status, "hold"),
        gt(reservations.holdExpiresAt, sql`now()`),
        sql`${reservations.checkInDate} < ${checkOut} AND ${reservations.checkOutDate} > ${checkIn}`,
      ),
    );
  return new Set(rows.map((r) => r.roomId));
}

function hotelCard(ctx: HotelCtx) {
  const { property, propertySettings } = ctx;
  return {
    name: propertySettings.hotelName || property.name,
    address: propertySettings.hotelAddress || property.address || "",
    phone: propertySettings.hotelPhone || property.phone || "",
    // Public URL of the hotel's own logo (public docs bucket). Rendered in
    // the guest page hero. Null falls back to the wordmark.
    logoUrl: propertySettings.hotelLogoUrl ?? null,
    checkInTime: property.defaultCheckInTime,
    checkOutTime: property.defaultCheckOutTime,
  };
}


// "non_ac_room" -> "Non Ac Room" for hotels whose type has no stored label.
function prettySlug(slug: string): string {
  return slug.replace(/[_-]+/g, " ").replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}

// ------------------------------------------------------------ room sticker

// Brochure view — safe for anyone. Reveals occupancy as a boolean only.
router.get("/room/:token", qrReadLimiter, async (req: Request, res: Response) => {
  const ctx = await loadRoomByToken(req.params.token);
  if (!ctx) return fail(res, 404, "NOT_FOUND", "Unknown code");
  const stay = await activeStayForRoom(ctx.property.id, ctx.room.id);
  return ok(res, {
    hotel: hotelCard(ctx),
    roomNumber: ctx.room.roomNumber,
    occupied: !!stay,
  });
});

// Prove you're the current guest: last 4 digits of the booking phone.
router.post(
  "/room/:token/unlock",
  qrUnlockLimiter,
  validate(qrUnlockSchema),
  async (req: Request, res: Response) => {
    const ctx = await loadRoomByToken(req.params.token);
    if (!ctx) return fail(res, 404, "NOT_FOUND", "Unknown code");
    const body = req.body as QrUnlockInput;

    const stay = await activeStayForRoom(ctx.property.id, ctx.room.id);
    if (!stay) return fail(res, 409, "ROOM_VACANT", "This room has no active stay");

    if (!stay.guestPhone.endsWith(body.phoneLast4)) {
      logger.warn(
        { roomId: ctx.room.id, ip: req.ip },
        "QR unlock failed: wrong phone digits",
      );
      return fail(res, 403, "WRONG_PHONE", "Those digits don't match the booking phone");
    }

    // Advisory geofence: log the distance when coordinates were shared.
    if (body.geo && ctx.propertySettings.hotelLatitude && ctx.propertySettings.hotelLongitude) {
      const distance = distanceM(
        body.geo.lat,
        body.geo.lng,
        Number(ctx.propertySettings.hotelLatitude),
        Number(ctx.propertySettings.hotelLongitude),
      );
      if (distance > ctx.propertySettings.qrUnlockRadiusM) {
        logger.warn(
          {
            roomId: ctx.room.id,
            reservationId: stay.reservationId,
            distanceM: distance,
            radiusM: ctx.propertySettings.qrUnlockRadiusM,
          },
          "QR unlock outside advisory radius",
        );
        await dispatchNotification({
          propertyId: ctx.property.id,
          type: "system",
          title: `Room ${ctx.room.roomNumber}: QR unlocked far from hotel`,
          body: `Unlock verified by phone digits but ~${Math.round(distance / 1000)} km away. Worth a glance.`,
          href: `/reservations/${stay.reservationId}`,
          recipientRoles: ["admin"],
        });
      }
    }

    // Key dies two days after the checkout date — covers late checkouts;
    // occupancy is re-checked on every request anyway.
    const exp = Math.floor(parseISO(stay.checkOutDate).getTime() / 1000) + 2 * 24 * 3600;
    return ok(res, { key: mintUnlockKey(ctx.room.id, stay.reservationId, exp) });
  },
);

// Unlocked room home: WiFi + stay card. Key required; occupancy re-checked
// per request so a photo of the page dies at checkout.
router.get("/room/:token/home", qrReadLimiter, async (req: Request, res: Response) => {
  const ctx = await loadRoomByToken(req.params.token);
  if (!ctx) return fail(res, 404, "NOT_FOUND", "Unknown code");
  const verified = verifyUnlockKey(String(req.query.key ?? ""), ctx.room.id);
  if (!verified) return fail(res, 401, "LOCKED", "Unlock first");
  const stay = await activeStayForRoom(ctx.property.id, ctx.room.id);
  if (!stay || stay.reservationId !== verified.reservationId) {
    return fail(res, 401, "STAY_ENDED", "This stay has ended");
  }
  return ok(res, {
    hotel: hotelCard(ctx),
    roomNumber: ctx.room.roomNumber,
    guestName: stay.guestName,
    checkOutDate: stay.checkOutDate,
    checkOutTime: ctx.property.defaultCheckOutTime,
    wifiSsid: ctx.propertySettings.wifiSsid,
    wifiPassword: ctx.propertySettings.wifiPassword,
  });
});

// Guest service request → staff notification. Occupancy re-checked; rate
// limited.
router.post(
  "/room/:token/request",
  qrWriteLimiter,
  validate(qrRequestSchema),
  async (req: Request, res: Response) => {
    const ctx = await loadRoomByToken(req.params.token);
    if (!ctx) return fail(res, 404, "NOT_FOUND", "Unknown code");
    const body = req.body as QrRequestInput;
    const verified = verifyUnlockKey(body.key, ctx.room.id);
    if (!verified) return fail(res, 401, "LOCKED", "Unlock first");
    const stay = await activeStayForRoom(ctx.property.id, ctx.room.id);
    if (!stay || stay.reservationId !== verified.reservationId) {
      return fail(res, 401, "STAY_ENDED", "This stay has ended");
    }

    const kindLabel =
      body.kind === "cleaning"
        ? "Room cleaning requested"
        : body.kind === "amenity"
          ? "Amenities requested"
          : "Problem reported";
    const note = (body.note ?? "").trim();

    await dispatchNotification({
      propertyId: ctx.property.id,
      type: "system",
      title: `Room ${ctx.room.roomNumber}: ${kindLabel}`,
      body: note || `${stay.guestName} asked via the in-room QR.`,
      href: `/reservations/${stay.reservationId}`,
      recipientRoles:
        body.kind === "issue" ? ["admin", "frontdesk"] : ["admin", "frontdesk", "housekeeping"],
    });
    logger.info(
      { roomId: ctx.room.id, reservationId: stay.reservationId, kind: body.kind },
      "QR guest request",
    );
    return ok(res, { received: true });
  },
);

// --------------------------------------------------------- hotel master QR

// Public catalog: rooms free TONIGHT, priced and typed, WITH photos and
// amenities so a guest can see what they're booking. Only clean, available
// rooms are offered — the desk handles everything else.
router.get("/hotel/:token", qrReadLimiter, async (req: Request, res: Response) => {
  const ctx = await loadHotelByToken(req.params.token);
  if (!ctx) return fail(res, 404, "NOT_FOUND", "Unknown code");
  const today = propertyToday();
  const tomorrow = format(addDays(parseISO(today), 1), "yyyy-MM-dd");
  const held = await heldRoomIds(ctx.property.id, today, tomorrow);
  const available = (await findAvailableRooms(ctx.property.id, today, tomorrow)).filter(
    (r) => r.status === "available" && !held.has(r.id),
  );
  const roomIds = available.map((r) => r.id);

  // Room-type display metadata (label + description) so the public page can
  // group rooms into booking-site style categories.
  const typeRows = await db
    .select({ slug: roomTypes.slug, label: roomTypes.label, description: roomTypes.description })
    .from(roomTypes)
    .where(eq(roomTypes.propertyId, ctx.property.id));
  const typeMeta = new Map(typeRows.map((t) => [t.slug, t]));

  // Photos (public bucket URLs) + amenity labels for the whole set in two
  // queries, then group per room. Empty roomIds → skip.
  const imagesByRoom = new Map<string, { url: string; caption: string | null }[]>();
  const amenitiesByRoom = new Map<string, string[]>();
  if (roomIds.length) {
    const imgs = await db
      .select({ roomId: roomImages.roomId, url: roomImages.url, caption: roomImages.caption })
      .from(roomImages)
      .where(inArray(roomImages.roomId, roomIds))
      .orderBy(asc(roomImages.sortOrder));
    for (const im of imgs) {
      const list = imagesByRoom.get(im.roomId) ?? [];
      list.push({ url: im.url, caption: im.caption });
      imagesByRoom.set(im.roomId, list);
    }
    const ams = await db
      .select({ roomId: roomAmenities.roomId, label: amenities.label })
      .from(roomAmenities)
      .innerJoin(amenities, eq(amenities.id, roomAmenities.amenityId))
      .where(inArray(roomAmenities.roomId, roomIds));
    for (const a of ams) {
      const list = amenitiesByRoom.get(a.roomId) ?? [];
      list.push(a.label);
      amenitiesByRoom.set(a.roomId, list);
    }
  }

  return ok(res, {
    hotel: hotelCard(ctx),
    rooms: available.map((r) => ({
      id: r.id,
      roomNumber: r.roomNumber,
      floor: r.floor,
      roomType: r.roomType,
      roomTypeLabel: typeMeta.get(r.roomType)?.label ?? prettySlug(r.roomType),
      roomTypeDescription: typeMeta.get(r.roomType)?.description ?? null,
      baseRate: Number(r.baseRate),
      maxOccupancy: r.maxOccupancy,
      hasAc: r.hasAc,
      hasTv: r.hasTv,
      hasWifi: r.hasWifi,
      images: imagesByRoom.get(r.id) ?? [],
      amenities: amenitiesByRoom.get(r.id) ?? [],
    })),
  });
});

// Per-target DB throttle + send the booking OTP.
router.post(
  "/hotel/:token/send-otp",
  qrWriteLimiter,
  validate(qrBookSendOtpSchema),
  async (req: Request, res: Response) => {
    const ctx = await loadHotelByToken(req.params.token);
    if (!ctx) return fail(res, 404, "NOT_FOUND", "Unknown code");
    const phone = (req.body as { phone: string }).phone;

    // 1/min per phone per hotel on top of the IP limiter.
    const recent = await db
      .select({ id: otps.id })
      .from(otps)
      .where(
        and(
          eq(otps.propertyId, ctx.property.id),
          eq(otps.purpose, "guest_verify"),
          eq(otps.target, phone),
          gt(otps.createdAt, sql`now() - interval '60 seconds'`),
        ),
      )
      .limit(1);
    if (recent.length) return fail(res, 429, "SLOW_DOWN", "Wait a minute before resending");

    const code = generateOtp();
    await db.insert(otps).values({
      propertyId: ctx.property.id,
      purpose: "guest_verify",
      channel: "sms",
      target: phone,
      codeHash: hashOtp(code),
      expiresAt: expiresAt(),
      ipAddress: req.ip,
    });
    await notifyGuestSms({
      to: phone,
      text: `${ctx.propertySettings.hotelName}: your booking verification code is ${code}`,
    });
    logger.info({ target: maskTarget(phone, "sms") }, "QR booking OTP sent");
    // Dev convenience mirrors the signup flow: never in production.
    return ok(res, {
      sent: true,
      ...(env.NODE_ENV !== "production" ? { devCode: code } : {}),
    });
  },
);

// The self-booking. OTP-verified; rooms re-checked; arrives as a
// non-blocking hold the desk must confirm.
router.post(
  "/hotel/:token/book",
  qrWriteLimiter,
  validate(qrBookSchema),
  async (req: Request, res: Response) => {
    const ctx = await loadHotelByToken(req.params.token);
    if (!ctx) return fail(res, 404, "NOT_FOUND", "Unknown code");
    const body = req.body as QrBookInput;
    const propertyId = ctx.property.id;
    const s = ctx.propertySettings;

    // OTP check (attempt-capped).
    const otpRows = await db
      .select()
      .from(otps)
      .where(
        and(
          eq(otps.propertyId, propertyId),
          eq(otps.purpose, "guest_verify"),
          eq(otps.target, body.phone),
          isNull(otps.consumedAt),
          gt(otps.expiresAt, sql`now()`),
        ),
      )
      .orderBy(sql`${otps.createdAt} DESC`)
      .limit(1);
    const otpRow = otpRows[0];
    if (!otpRow) return fail(res, 400, "OTP_REQUIRED", "Request a new code");
    if (otpRow.attempts >= env.OTP_MAX_ATTEMPTS) {
      return fail(res, 429, "OTP_LOCKED", "Too many wrong codes. Request a new one.");
    }
    if (otpRow.codeHash !== hashOtp(body.otpCode)) {
      await db
        .update(otps)
        .set({ attempts: otpRow.attempts + 1 })
        .where(eq(otps.id, otpRow.id));
      return fail(res, 400, "OTP_WRONG", "That code is not right");
    }

    // Dates: tonight, N nights.
    const checkIn = propertyToday();
    const checkOut = format(addDays(parseISO(checkIn), body.nights), "yyyy-MM-dd");

    // Rooms must belong to this hotel and still be free for the window —
    // including free of OTHER guests' live holds (the DB constraint would
    // reject the overlap anyway; this turns it into a readable answer).
    const held = await heldRoomIds(propertyId, checkIn, checkOut);
    const free = await findAvailableRooms(propertyId, checkIn, checkOut);
    const freeById = new Map(
      free.filter((r) => r.status === "available" && !held.has(r.id)).map((r) => [r.id, r]),
    );
    const chosen = body.roomIds
      .map((id) => freeById.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r);
    if (chosen.length !== body.roomIds.length) {
      return fail(res, 409, "ROOM_TAKEN", "One of those rooms was just taken. Pick again.");
    }

    // Money mirrors the staff walk-in path: slab from the average nightly
    // rate, then the property's GST mode.
    const perNight = chosen.reduce((a, r) => a + Number(r.baseRate), 0);
    const gross = +(perNight * body.nights).toFixed(2);
    const avgRate = perNight / chosen.length;
    const gstRate = getGstRate(avgRate, {
      exemptBelow: Number(s.gstSlabExemptBelow),
      lowRate: Number(s.gstSlabLowRate),
      lowMax: Number(s.gstSlabLowMax),
      highRate: Number(s.gstSlabHighRate),
    });
    const gstMode = s.gstMode ?? "exclusive";
    const money = calcGstBreakdown(gross, gstRate, gstMode);

    const result = await db.transaction(async (tx) => {
      // Find-or-create the guest within this hotel. Guests are unique per
      // hotel by phone, by ID proof AND by email — a returning guest may
      // match on any of them (new SIM, same Aadhaar is common), so probe all
      // three before inserting or the unique indexes reject the booking.
      const hash = idProofHash(body.idProofNumber);
      const matches = await tx
        .select({ id: guests.id, phone: guests.phone })
        .from(guests)
        .where(
          and(
            eq(guests.propertyId, propertyId),
            sql`(${guests.phone} = ${body.phone}
                 OR (${guests.idProofType} = ${body.idProofType} AND ${guests.idProofHash} = ${hash})
                 ${body.email ? sql`OR lower(${guests.email}) = ${body.email.toLowerCase()}` : sql``})`,
          ),
        )
        .limit(1);
      let guestId: string;
      if (matches[0]) {
        guestId = matches[0].id;
      } else {
        const inserted = await tx
          .insert(guests)
          .values({
            propertyId,
            fullName: body.fullName,
            phone: body.phone,
            email: body.email || null,
            gender: body.gender,
            idProofType: body.idProofType,
            idProofNumberEncrypted: encrypt(body.idProofNumber),
            idProofLast4: last4(body.idProofNumber),
            idProofHash: idProofHash(body.idProofNumber),
            nationality: body.nationality || "Indian",
            address: body.address || null,
            city: body.city || null,
            state: body.state || null,
            gstin: body.gstin || null,
          })
          .returning({ id: guests.id });
        guestId = inserted[0]!.id;
      }

      const seq = await nextDocNumber(tx, propertyId, "reservation");
      const resNumber = reservationNumber(seq);
      const holdExpiresAt = new Date(Date.now() + 30 * 60 * 1000);

      const insertedRes = await tx
        .insert(reservations)
        .values({
          reservationNumber: resNumber,
          propertyId,
          guestId,
          checkInDate: checkIn,
          checkOutDate: checkOut,
          numAdults: body.numAdults,
          ratePerNight: String(perNight),
          subtotal: String(money.subtotal),
          gstRate: String(gstRate),
          gstAmount: String(money.gstAmount),
          gstMode,
          grandTotal: String(money.grandTotal),
          balanceDue: String(money.grandTotal),
          status: "hold",
          bookingSource: "qr",
          specialRequests: body.specialRequests ?? null,
          holdExpiresAt,
          createdBy: null,
        })
        .returning({ id: reservations.id });
      const reservationId = insertedRes[0]!.id;

      await tx.insert(reservationRooms).values(
        chosen.map((r) => ({
          reservationId,
          roomId: r.id,
          ratePerNight: String(Number(r.baseRate)),
          guestId,
          status: "confirmed" as const,
        })),
      );
      return { reservationId, resNumber, holdExpiresAt };
    });

    await db.update(otps).set({ consumedAt: new Date() }).where(eq(otps.id, otpRow.id));

    await dispatchNotification({
      propertyId,
      type: "reservation_created",
      title: `QR booking ${result.resNumber} awaiting confirmation`,
      body: `${body.fullName} · Room ${chosen.map((r) => r.roomNumber).join(", ")} · ${body.nights} night${body.nights === 1 ? "" : "s"} · expires in 30 min`,
      href: `/reservations/${result.reservationId}`,
      recipientRoles: ["admin", "frontdesk"],
    });
    logger.info(
      { reservationId: result.reservationId, rooms: chosen.map((r) => r.roomNumber) },
      "QR self-booking created",
    );

    return ok(res, {
      reservationNumber: result.resNumber,
      grandTotal: money.grandTotal,
      holdExpiresAt: result.holdExpiresAt.toISOString(),
      message:
        "Show this screen at the front desk. They'll confirm your booking and take payment.",
    });
  },
);

// -------------------------------------------------------------- hold sweep

// Expire unconfirmed QR holds. Called from index.ts on an interval. A
// cross-tenant system job by design (like migrations) — it only ever
// touches rows every hotel wants dead.
export async function sweepExpiredHolds(): Promise<number> {
  const swept = await db
    .update(reservations)
    .set({
      status: "cancelled",
      cancellationReason: "QR booking expired: not confirmed at the front desk in time",
      updatedAt: new Date(),
    })
    .where(and(eq(reservations.status, "hold"), lt(reservations.holdExpiresAt, sql`now()`)))
    .returning({ id: reservations.id, propertyId: reservations.propertyId });
  if (swept.length) {
    logger.info({ count: swept.length }, "Expired QR holds swept");
  }
  return swept.length;
}

export default router;

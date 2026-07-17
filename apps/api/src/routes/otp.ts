import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { guests, otps, reservations } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";
import { messaging } from "../lib/messaging.js";
import { expiresAt, generateOtp, hashOtp, maskTarget } from "../lib/otp.js";
import { normalisePhone } from "../lib/phone.js";
import { renderTemplate } from "../lib/templates.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// Exactly one anchor:
//   reservationId — legacy: OTP after a reservation row exists.
//   guestId       — OTP before the reservation is created (existing guest).
//   phone         — OTP before ANYTHING exists: a brand-new walk-in guest is
//                   verified by phone alone, and the guest row is only
//                   written after the code checks out. Keeps abandoned
//                   bookings from leaving orphan guest records.
const sendSchema = z
  .object({
    reservationId: z.string().uuid().optional(),
    guestId: z.string().uuid().optional(),
    phone: z.string().min(8).max(20).optional(),
    channel: z.enum(["sms", "email"]),
  })
  .refine((d) => [d.reservationId, d.guestId, d.phone].filter(Boolean).length === 1, {
    message: "Provide exactly one of reservationId, guestId or phone",
  })
  .refine((d) => !d.phone || d.channel === "sms", {
    message: "phone-anchored OTP only supports the sms channel",
  });

router.post("/send", requireAuth, validate(sendSchema), async (req, res) => {
  const { reservationId, guestId, phone, channel } = req.body as z.infer<typeof sendSchema>;

  // Resolve the target. Three paths:
  //   1. reservationId → look up reservation → guest
  //   2. guestId       → look up guest directly (no reservation in DB yet)
  //   3. phone         → no DB rows at all yet; the phone IS the target
  let g: typeof guests.$inferSelect | undefined;
  let resvId: string | null = null;
  if (reservationId) {
    const [r] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId))
      .limit(1);
    if (!r) return fail(res, 404, "NOT_FOUND", "Reservation not found");
    resvId = r.id;
    const [foundGuest] = await db
      .select()
      .from(guests)
      .where(eq(guests.id, r.guestId))
      .limit(1);
    g = foundGuest;
  } else if (guestId) {
    const [foundGuest] = await db
      .select()
      .from(guests)
      .where(eq(guests.id, guestId))
      .limit(1);
    g = foundGuest;
  }
  if (!g && !phone) return fail(res, 404, "NOT_FOUND", "Guest not found");

  // Normalise the raw-phone anchor the same way guest rows are stored, so
  // the reservation-create lookup (target = guest.phone) always matches.
  const target = phone ? normalisePhone(phone) : channel === "sms" ? g!.phone : g!.email;
  if (!target) {
    return fail(res, 400, "NO_TARGET", channel === "sms" ? "Guest has no phone on file" : "Guest has no email on file");
  }

  // Tiered throttling.
  // 1) Per-target cool-down: one OTP per minute per phone/email.
  // 2) Per-target daily cap: 10 OTPs in 24h to the same recipient (catches
  //    someone abusing a real guest's number).
  // 3) Per-IP hourly cap: 30 OTP sends from one client IP per hour
  //    (catches scripted abuse even if the attacker rotates targets).
  // The activity_log captures every block reason for incident review.
  const recent = await db
    .select({ id: otps.id })
    .from(otps)
    .where(
      and(
        eq(otps.target, target),
        eq(otps.purpose, "checkin"),
        gt(otps.createdAt, sql`now() - interval '1 minute'`),
      ),
    )
    .limit(1);
  if (recent.length > 0) {
    logger.warn({ target: maskTarget(target, channel), reason: "cooldown" }, "OTP throttle");
    return fail(res, 429, "RATE_LIMITED", "Please wait before requesting a new code");
  }

  const dailyCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(otps)
    .where(
      and(
        eq(otps.target, target),
        eq(otps.purpose, "checkin"),
        gt(otps.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  if ((dailyCount[0]?.n ?? 0) >= 10) {
    logger.warn(
      { target: maskTarget(target, channel), reason: "daily_cap" },
      "OTP throttle",
    );
    return fail(
      res,
      429,
      "RATE_LIMITED",
      "This recipient has reached the daily OTP limit. Try again tomorrow.",
    );
  }

  // Per-IP hourly cap. ipAddress is recorded on otps rows for this reason.
  // Falls back to 'unknown' when behind a proxy without trust proxy set, but
  // trust proxy is set in index.ts so req.ip resolves to the real client.
  const clientIp = req.ip ?? "unknown";
  const ipCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(otps)
    .where(
      and(
        eq(otps.ipAddress, clientIp),
        gt(otps.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((ipCount[0]?.n ?? 0) >= 30) {
    logger.warn({ ip: clientIp, reason: "ip_cap" }, "OTP throttle");
    return fail(
      res,
      429,
      "RATE_LIMITED",
      "Too many OTP requests from this device. Slow down.",
    );
  }

  const code = generateOtp();
  const [row] = await db
    .insert(otps)
    .values({
      purpose: "checkin",
      channel,
      target,
      codeHash: hashOtp(code),
      reservationId: resvId,
      // Phone-anchored OTP: no guest row exists yet — the row is keyed by
      // target alone and matched by phone at reservation-create time.
      guestId: g?.id ?? null,
      expiresAt: expiresAt(),
      ipAddress: clientIp,
    })
    .returning({ id: otps.id });

  const otpVars = {
    hotel: env.HOTEL_DISPLAY_NAME,
    otp_code: code,
    otp_minutes: Math.floor(env.OTP_TTL_SECONDS / 60),
  };
  if (channel === "sms") {
    const t = await renderTemplate("otp_guest_sms", otpVars);
    await messaging.sendSms({ to: target, text: t.body });
  } else {
    // Email OTP uses the same body template since there's no separate email template for OTP
    const t = await renderTemplate("otp_guest_sms", otpVars);
    await messaging.sendEmail({
      to: target,
      subject: `${env.HOTEL_DISPLAY_NAME} check-in code: ${code}`,
      text: t.body,
    });
  }

  if (env.NOTIFICATIONS_PROVIDER === "stub") {
    // Stub mode (dev) returns the code in the response body for the test
    // harness. We deliberately do NOT log the raw code here — log files
    // get archived/shipped to monitoring systems and leaking OTP codes in
    // a hotel-staff log review would be a real privacy/security issue.
    // The target is also masked so a developer skimming logs can identify
    // the test guest without seeing their full phone/email.
    logger.info(
      { target: maskTarget(target, channel) },
      "[OTP] generated in stub mode (code returned to caller, not logged)",
    );
  }

  return ok(res, {
    id: row!.id,
    channel,
    target: maskTarget(target, channel),
    expiresInSeconds: env.OTP_TTL_SECONDS,
    devCode: env.NOTIFICATIONS_PROVIDER === "stub" ? code : undefined,
  });
});

// Same anchors as send: exactly one of reservationId, guestId or phone.
const verifySchema = z
  .object({
    reservationId: z.string().uuid().optional(),
    guestId: z.string().uuid().optional(),
    phone: z.string().min(8).max(20).optional(),
    code: z.string().min(4).max(8),
  })
  .refine((d) => [d.reservationId, d.guestId, d.phone].filter(Boolean).length === 1, {
    message: "Provide exactly one of reservationId, guestId or phone",
  });

router.post("/verify", requireAuth, validate(verifySchema), async (req, res) => {
  const { reservationId, guestId, phone, code } = req.body as z.infer<typeof verifySchema>;
  const clientIp = req.ip ?? "unknown";

  // Look up the most recent non-consumed OTP by the anchor used at send.
  const whereClause = reservationId
    ? and(
        eq(otps.reservationId, reservationId),
        eq(otps.purpose, "checkin"),
        isNull(otps.consumedAt),
      )
    : guestId
      ? and(
          eq(otps.guestId, guestId),
          // In guest-only mode there's no reservation yet, so the row must
          // not be linked to one. This stops a code intended for a different
          // active reservation from being reused for a fresh booking.
          isNull(otps.reservationId),
          eq(otps.purpose, "checkin"),
          isNull(otps.consumedAt),
        )
      : and(
          // Phone-anchored: no guest row exists yet either — match by the
          // send target with both anchors empty.
          eq(otps.target, normalisePhone(phone!)),
          isNull(otps.reservationId),
          isNull(otps.guestId),
          eq(otps.purpose, "checkin"),
          isNull(otps.consumedAt),
        );

  const [row] = await db
    .select()
    .from(otps)
    .where(whereClause)
    .orderBy(sql`${otps.createdAt} desc`)
    .limit(1);

  const anchorLog = reservationId ? { reservationId } : guestId ? { guestId } : { phone };

  if (!row) {
    logger.warn({ ...anchorLog, ip: clientIp, reason: "no_otp" }, "OTP verify failed");
    return fail(res, 404, "NO_OTP", "No active OTP found");
  }
  if (row.expiresAt < new Date()) {
    logger.warn({ ...anchorLog, ip: clientIp, reason: "expired" }, "OTP verify failed");
    return fail(res, 400, "EXPIRED", "OTP has expired, request a new one");
  }
  if (row.attempts >= env.OTP_MAX_ATTEMPTS) {
    logger.warn(
      { ...anchorLog, ip: clientIp, attempts: row.attempts, reason: "max_attempts" },
      "OTP verify failed",
    );
    return fail(res, 429, "TOO_MANY_ATTEMPTS", "Too many wrong attempts, request a new OTP");
  }

  if (row.codeHash !== hashOtp(code)) {
    await db.update(otps).set({ attempts: row.attempts + 1 }).where(eq(otps.id, row.id));
    logger.warn(
      { ...anchorLog, ip: clientIp, attempts: row.attempts + 1, reason: "wrong_code" },
      "OTP verify failed",
    );
    return fail(res, 400, "INVALID_CODE", "Incorrect code");
  }

  // We DON'T mark the OTP consumed here when verifying for a not-yet-
  // created reservation. The reservation-create endpoint will check the
  // OTP itself and mark it consumed in the same transaction so a verified
  // OTP can't be replayed against a different payload.
  if (reservationId) {
    await db.update(otps).set({ consumedAt: new Date() }).where(eq(otps.id, row.id));
  }

  return ok(res, {
    verified: true,
    reservationId: reservationId ?? null,
    guestId: guestId ?? null,
    verifiedAt: new Date().toISOString(),
  });
});

export default router;

// Public (unauthenticated) surface. Today: hotel signup only.
//
// POST /public/signup — creates the Supabase auth user, then provisions the
// whole tenant in one DB transaction (property + settings + admin profile +
// role assignment + trialing subscription). The auth user is the only piece
// that can't join the transaction, so a failed transaction compensates by
// deleting it — no half-provisioned hotels, no orphaned logins.

import {
  signupSchema,
  signupSendOtpSchema,
  type SignupInput,
  type SignupSendOtpInput,
} from "@stayvia/shared";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { otps } from "../db/schema/otps.js";
import { profiles } from "../db/schema/profiles.js";
import { subscriptions } from "../db/schema/subscriptions.js";
import { logger } from "../lib/logger.js";
import { messaging } from "../lib/messaging.js";
import { expiresAt, generateOtp, hashOtp, maskTarget } from "../lib/otp.js";
import { provisionAdmin, provisionProperty } from "../lib/provisionProperty.js";
import { seedRbacCatalog } from "../lib/rbacCatalog.js";
import { fail, ok } from "../lib/response.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { signupLimiter, signupOtpLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// Signup OTPs are pre-tenant: property_id stays NULL and the row is keyed
// purely by (purpose='signup', channel, target).
function signupOtpTarget(channel: "email" | "sms", email: string, phone?: string): string {
  return channel === "email" ? email.trim().toLowerCase() : phone!.trim();
}

// True when a COMPLETED account (auth user + profile) already uses this
// email. Orphaned auth users without a profile don't count — the signup
// route reclaims those.
async function emailHasAccount(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(sql`lower(${profiles.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return rows.length > 0;
}

// Find a Supabase auth user by email via the admin list API (no direct
// lookup-by-email exists). Bounded scan — only used on the rare
// email_exists collision path.
async function findAuthUserByEmail(email: string) {
  const needle = email.trim().toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data.users.length) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === needle);
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /public/signup/send-otp — deliver a verification code on the chosen
// channel before the hotel is created. Registered emails are rejected HERE,
// before any code is sent, so nobody completes the whole verification dance
// only to hit a 409 at the end. (Mild enumeration trade-off, accepted: the
// endpoint is rate-limited and the final signup call reveals the same fact.)
// ---------------------------------------------------------------------------
router.post(
  "/signup/send-otp",
  signupOtpLimiter,
  validate(signupSendOtpSchema),
  async (req, res) => {
    const input = req.body as SignupSendOtpInput;
    const clientIp = req.ip ?? "unknown";
    const target = signupOtpTarget(input.channel, input.email, input.phone);

    if (await emailHasAccount(input.email)) {
      logger.warn({ ip: clientIp }, "signup send-otp rejected: email already registered");
      return fail(res, 409, "EMAIL_IN_USE", "This email cannot be used for signup");
    }

    // Email channel needs a configured provider in live mode; in stub mode
    // the code comes back in the response for local testing.
    if (
      input.channel === "email" &&
      env.NOTIFICATIONS_PROVIDER === "live" &&
      !messaging.isEmailConfigured()
    ) {
      return fail(
        res,
        503,
        "EMAIL_UNAVAILABLE",
        "Email verification is unavailable right now. Verify via WhatsApp instead.",
      );
    }

    // Same per-target throttling shape as the password-change OTP path:
    // one per minute, 10 per day.
    const recent = await db
      .select({ id: otps.id })
      .from(otps)
      .where(
        and(
          eq(otps.purpose, "signup"),
          eq(otps.target, target),
          gt(otps.createdAt, sql`now() - interval '1 minute'`),
        ),
      )
      .limit(1);
    if (recent.length > 0) {
      return fail(res, 429, "RATE_LIMITED", "Please wait before requesting a new code");
    }

    const daily = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(otps)
      .where(
        and(
          eq(otps.purpose, "signup"),
          eq(otps.target, target),
          gt(otps.createdAt, sql`now() - interval '24 hours'`),
        ),
      );
    if ((daily[0]?.n ?? 0) >= 10) {
      return fail(res, 429, "RATE_LIMITED", "Daily verification limit reached. Try again tomorrow.");
    }

    const code = generateOtp();
    await db.insert(otps).values({
      propertyId: null,
      purpose: "signup",
      channel: input.channel,
      target,
      codeHash: hashOtp(code),
      reservationId: null,
      guestId: null,
      expiresAt: expiresAt(),
      ipAddress: clientIp,
    });

    const minutes = Math.floor(env.OTP_TTL_SECONDS / 60);
    const text = `Stayvia: Your signup verification code is ${code}. Valid for ${minutes} minutes. Do not share this code.`;
    const sendResult =
      input.channel === "email"
        ? await messaging.sendEmail({
            to: target,
            subject: "Your Stayvia verification code",
            text,
          })
        : await messaging.sendSms({ to: target, text });
    if (!sendResult.ok && env.NOTIFICATIONS_PROVIDER === "live") {
      logger.warn({ error: sendResult.error, channel: input.channel }, "signup OTP send failed");
      return fail(res, 502, "DELIVERY_FAILED", "Could not send the code. Try again in a moment.");
    }

    return ok(res, {
      target: maskTarget(target, input.channel),
      channel: input.channel,
      expiresInSeconds: env.OTP_TTL_SECONDS,
      // Stub mode only — mirrors the guest/password OTP devCode behaviour.
      devCode: env.NOTIFICATIONS_PROVIDER === "stub" ? code : undefined,
    });
  },
);

router.post("/signup", signupLimiter, validate(signupSchema), async (req, res) => {
  const input = req.body as SignupInput;
  const clientIp = req.ip ?? "unknown";

  // 0. The contact must have been verified: newest unconsumed signup OTP
  //    for the chosen channel+target has to match. Consumed only after
  //    provisioning succeeds, so a failed signup can retry with the same
  //    code inside its TTL.
  const target = signupOtpTarget(input.otpChannel, input.email, input.phone);
  const [otpRow] = await db
    .select()
    .from(otps)
    .where(
      and(
        eq(otps.purpose, "signup"),
        eq(otps.channel, input.otpChannel),
        eq(otps.target, target),
        isNull(otps.consumedAt),
      ),
    )
    .orderBy(sql`${otps.createdAt} desc`)
    .limit(1);

  if (!otpRow) {
    return fail(res, 400, "NO_OTP", "No active verification code. Request a new one.");
  }
  if (otpRow.expiresAt < new Date()) {
    return fail(res, 400, "OTP_EXPIRED", "Verification code expired. Request a new one.");
  }
  if (otpRow.attempts >= env.OTP_MAX_ATTEMPTS) {
    return fail(res, 429, "TOO_MANY_ATTEMPTS", "Too many wrong attempts. Request a new code.");
  }
  if (otpRow.codeHash !== hashOtp(input.otp)) {
    await db.update(otps).set({ attempts: otpRow.attempts + 1 }).where(eq(otps.id, otpRow.id));
    return fail(res, 400, "INVALID_CODE", "Incorrect verification code");
  }

  // 1. Supabase auth user. email_confirm skips the confirmation email —
  //    the owner signs in immediately after signup. Runs ONLY after the
  //    OTP above verified — no account exists before verification.
  let created = await supabaseAdmin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    const code = (created.error as { code?: string } | null)?.code;
    const isDuplicate =
      code === "email_exists" || created.error?.message?.toLowerCase().includes("already");
    if (isDuplicate) {
      // Two cases. A COMPLETED account (profile exists) → genuine 409,
      // deliberately non-revealing (Supabase users are platform-global;
      // details would enable cross-tenant enumeration). An ORPHANED auth
      // user (no profile — a previous signup died between createUser and
      // provisioning, or its compensation delete failed) → reclaim it so
      // the email isn't stuck forever.
      if (await emailHasAccount(input.email)) {
        logger.warn({ ip: clientIp }, "signup rejected: email already registered");
        return fail(res, 409, "EMAIL_IN_USE", "This email cannot be used for signup");
      }
      const orphan = await findAuthUserByEmail(input.email);
      if (orphan) {
        logger.warn({ ip: clientIp, orphanId: orphan.id }, "signup: reclaiming orphaned auth user");
        await supabaseAdmin.auth.admin.deleteUser(orphan.id);
        created = await supabaseAdmin.auth.admin.createUser({
          email: input.email,
          password: input.password,
          email_confirm: true,
        });
      }
    }
    if (created.error || !created.data.user) {
      logger.error(
        { ip: clientIp, reason: created.error?.message ?? "no user" },
        "signup: createUser failed",
      );
      return fail(res, 502, "AUTH_ERROR", "Could not create the account. Try again.");
    }
  }
  const userId = created.data.user.id;

  // 2. Global RBAC catalog + system roles. Idempotent and commits via its
  //    own connection, so it runs before the tenant transaction — a
  //    rolled-back signup leaves only shared rows that every tenant needs.
  try {
    await seedRbacCatalog();

    const { propertyId } = await db.transaction(async (tx) => {
      const provisioned = await provisionProperty(tx, { name: input.hotelName });
      await provisionAdmin(tx, {
        propertyId: provisioned.propertyId,
        profileId: userId,
        fullName: input.ownerName,
        email: input.email,
        phone: input.phone ?? null,
      });
      await tx.insert(subscriptions).values({
        propertyId: provisioned.propertyId,
        plan: "standard",
        status: "trialing",
        trialEndsAt: new Date(Date.now() + env.TRIAL_DAYS * 24 * 60 * 60 * 1000),
      });
      return provisioned;
    });

    await db.update(otps).set({ consumedAt: new Date() }).where(eq(otps.id, otpRow.id));

    logger.info({ propertyId, userId, ip: clientIp }, "hotel signup provisioned");
    return ok(res, { propertyId }, 201);
  } catch (err) {
    // Compensate: the auth user exists but the tenant doesn't. Delete the
    // user so the email can retry cleanly instead of 409ing forever.
    logger.error({ err, userId, ip: clientIp }, "signup: provisioning failed, compensating");
    try {
      await supabaseAdmin.auth.admin.deleteUser(userId);
    } catch (delErr) {
      logger.error({ err: delErr, userId }, "signup: compensation deleteUser failed");
    }
    return fail(res, 500, "SIGNUP_FAILED", "Signup failed. Please try again.");
  }
});

export default router;

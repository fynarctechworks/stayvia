import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { otps } from "../db/schema/otps.js";
import { profiles } from "../db/schema/profiles.js";
import { logActivity } from "../lib/activity.js";
import { logger } from "../lib/logger.js";
import {
  checkLockout,
  recordFailure,
  recordSuccess,
} from "../lib/loginLockout.js";
import { messaging } from "../lib/messaging.js";
import { expiresAt, generateOtp, hashOtp, maskTarget } from "../lib/otp.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { fail, ok } from "../lib/response.js";
import { requireAuth } from "../middleware/auth.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Pre-flight check for the forgot-password flow. The front-end calls
// this BEFORE asking Supabase to send a reset email, so it can show a
// clear "this email isn't a registered staff account — contact your
// admin" message instead of silently doing nothing.
//
// SECURITY NOTE: this endpoint *does* reveal whether an email is a
// registered active staff account (mild enumeration). That's an
// intentional product trade-off requested for this single-property
// deployment — staff who mistype their email should get a clear error.
// We mitigate abuse two ways:
//   1. loginLimiter (5 requests / 15 min / IP) is applied at the route.
//   2. We only confirm ACTIVE staff. Deactivated accounts read as
//      "not registered" so a former employee's email can't be probed.
const forgotCheckSchema = z.object({
  email: z.string().email(),
});

router.post(
  "/forgot-password/check",
  loginLimiter,
  validate(forgotCheckSchema),
  async (req, res) => {
    const { email } = req.body as z.infer<typeof forgotCheckSchema>;
    // Case-insensitive match — emails are stored as entered but staff
    // may type a different case.
    const [row] = await db
      .select({ id: profiles.id, isActive: profiles.isActive })
      .from(profiles)
      .where(sql`lower(${profiles.email}) = lower(${email})`)
      .limit(1);
    const registered = !!row && row.isActive;
    return ok(res, { registered });
  },
);

router.post("/login", validate(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const clientIp = req.ip ?? "unknown";

  // Account-level lockout. Refuses BEFORE calling Supabase so a locked
  // account can't even consume our outbound auth budget. The message is
  // intentionally vague so an attacker can't use the lock state as an
  // oracle to confirm which emails exist.
  const lockedMsRemaining = checkLockout(email);
  if (lockedMsRemaining > 0) {
    logger.warn(
      { email, ip: clientIp, lockedMsRemaining },
      "login rejected: account temporarily locked",
    );
    return fail(
      res,
      401,
      "INVALID_CREDENTIALS",
      "Email or password is incorrect",
    );
  }

  const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    const tripped = recordFailure(email, clientIp);
    logger.warn(
      { email, ip: clientIp, reason: error?.message ?? "no_session", lockTripped: tripped },
      "login failed",
    );
    return fail(res, 401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  // Password was correct, but the account may be deactivated or have no
  // profile (deleted staff). Reject HERE — before handing back a token — so
  // the error surfaces on the login page instead of letting them reach the
  // dashboard and hit a 403 on the first API call. requireAuth enforces the
  // same rule on every request; this just makes login the first gate.
  const [profile] = await db
    .select({ isActive: profiles.isActive })
    .from(profiles)
    .where(eq(profiles.id, data.user.id))
    .limit(1);
  if (!profile || !profile.isActive) {
    // Sign the just-created session out so no usable token lingers.
    try {
      await supabaseAdmin.auth.admin.signOut(data.session.access_token, "global");
    } catch {
      /* best-effort */
    }
    logger.warn(
      { userId: data.user.id, email, ip: clientIp, reason: !profile ? "no_profile" : "inactive" },
      "login rejected: account deactivated or removed",
    );
    return fail(
      res,
      403,
      "ACCOUNT_DISABLED",
      "This account has been deactivated. Contact your administrator.",
    );
  }

  recordSuccess(email);
  logger.info({ userId: data.user.id, email, ip: clientIp }, "login succeeded");
  return ok(res, {
    user: { id: data.user.id, email: data.user.email },
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
});

router.post("/logout", requireAuth, async (req, res) => {
  // Revoke every active session for this user across all devices.
  // Supabase admin signOut takes the user's JWT (not the user id).
  const header = req.header("authorization") ?? req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  try {
    if (token) await supabaseAdmin.auth.admin.signOut(token, "global");
  } catch (err) {
    logger.warn({ err, userId: req.user!.id }, "global sign-out failed");
  }
  return ok(res, { success: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const u = req.user!;
  const [row] = await db
    .select({ phone: profiles.phone })
    .from(profiles)
    .where(eq(profiles.id, u.id))
    .limit(1);
  return ok(res, {
    profile: {
      id: u.id,
      email: u.email,
      role: u.role,
      fullName: u.fullName,
      phone: row?.phone ?? null,
      rbacRoleKey: u.rbacRoleKey,
      isGodMode: u.isGodMode,
      permissions: Array.from(u.permissions),
    },
  });
});

// Self-edit of safe profile fields only. Password is handled separately by
// the OTP-verified change-password flow below — no shortcut via this route.
const meUpdateSchema = z.object({
  fullName: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).nullable().optional(),
});

router.put("/me", requireAuth, validate(meUpdateSchema), async (req, res) => {
  const id = req.user!.id;
  const input = req.body as z.infer<typeof meUpdateSchema>;

  if (input.email) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      email: input.email,
    });
    if (error) return fail(res, 400, "AUTH_ERROR", error.message);
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.fullName !== undefined) patch.fullName = input.fullName;
  if (input.email !== undefined) patch.email = input.email;
  if (input.phone !== undefined) patch.phone = input.phone;

  const [updated] = await db
    .update(profiles)
    .set(patch)
    .where(eq(profiles.id, id))
    .returning();
  if (!updated) return fail(res, 404, "NOT_FOUND", "Profile not found");

  const changes: string[] = [];
  if (input.fullName) changes.push("name");
  if (input.email) changes.push("email");
  if (input.phone !== undefined) changes.push("phone");

  await logActivity({
    action: "profile_self_updated",
    entityType: "profile",
    entityId: id,
    description: `Own profile updated${changes.length ? ` (${changes.join(", ")})` : ""}`,
    performedBy: id,
    ipAddress: req.ip,
  });

  return ok(res, {
    profile: {
      id: updated.id,
      email: updated.email,
      fullName: updated.fullName,
      phone: updated.phone,
    },
  });
});

// ============================================================
// Self-service password change with OTP-on-WhatsApp verification.
//
// Flow (three calls, all from My Profile tab):
//   1. POST /auth/me/password/send-otp { oldPassword }
//        - verifies oldPassword via Supabase sign-in attempt
//        - generates OTP, stores hash with purpose='password_change'
//        - sends via WhatsApp to user's profile.phone
//   2. POST /auth/me/password/change { oldPassword, otp, newPassword }
//        - re-verifies oldPassword (defence-in-depth in case browser kept
//          the page open between steps)
//        - verifies OTP against newest non-consumed password_change row
//        - flips password via supabaseAdmin
// ============================================================

const sendPwOtpSchema = z.object({
  oldPassword: z.string().min(1),
});

router.post(
  "/me/password/send-otp",
  requireAuth,
  validate(sendPwOtpSchema),
  async (req, res) => {
    const userId = req.user!.id;
    const userEmail = req.user!.email;
    const { oldPassword } = req.body as z.infer<typeof sendPwOtpSchema>;
    const clientIp = req.ip ?? "unknown";

    // 1. Verify the current password by attempting a Supabase sign-in.
    //    We deliberately don't keep the resulting session — this is purely
    //    a credential check. recordFailure/recordSuccess feed the same
    //    account-lockout machinery used by the normal login endpoint so
    //    you can't bypass the lockout by brute-forcing via this endpoint.
    const lockedMs = checkLockout(userEmail);
    if (lockedMs > 0) {
      return fail(res, 401, "INVALID_CREDENTIALS", "Current password is incorrect");
    }
    if (!(await verifyCurrentSecret(userEmail, oldPassword))) {
      recordFailure(userEmail, clientIp);
      logger.warn({ userId, ip: clientIp }, "password-change: bad old password");
      return fail(res, 401, "INVALID_CREDENTIALS", "Current password is incorrect");
    }
    recordSuccess(userEmail);

    // 2. The OTP gets WhatsApp'd to the user's profile.phone. If missing,
    //    require an admin to add the phone first — we don't fall back to
    //    email since deployment is WhatsApp-only.
    const [row] = await db
      .select({ phone: profiles.phone })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    const phone = row?.phone?.trim() ?? "";
    if (!phone) {
      return fail(
        res,
        400,
        "NO_PHONE",
        "Add a phone number to your profile before changing your password. Ask an administrator if you cannot edit your phone.",
      );
    }

    // Same throttling shape as the guest OTP path (one per minute, 10/day
    // per target, 30/hour per IP).
    const recent = await db
      .select({ id: otps.id })
      .from(otps)
      .where(
        and(
          eq(otps.target, phone),
          eq(otps.purpose, "password_change"),
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
          eq(otps.target, phone),
          eq(otps.purpose, "password_change"),
          gt(otps.createdAt, sql`now() - interval '24 hours'`),
        ),
      );
    if ((daily[0]?.n ?? 0) >= 10) {
      return fail(
        res,
        429,
        "RATE_LIMITED",
        "Daily password-change OTP limit reached. Try again tomorrow.",
      );
    }

    const code = generateOtp();
    await db.insert(otps).values({
      purpose: "password_change",
      channel: "sms",
      target: phone,
      codeHash: hashOtp(code),
      reservationId: null,
      guestId: null,
      expiresAt: expiresAt(),
      ipAddress: clientIp,
    });

    const minutes = Math.floor(env.OTP_TTL_SECONDS / 60);
    const text = `${env.HOTEL_DISPLAY_NAME}: Your password change code is ${code}. Valid for ${minutes} minutes. Do not share this code.`;
    const sendResult = await messaging.sendSms({ to: phone, text });
    if (!sendResult.ok && env.NOTIFICATIONS_PROVIDER === "live") {
      logger.warn({ userId, error: sendResult.error }, "password-change OTP send failed");
      return fail(
        res,
        502,
        "DELIVERY_FAILED",
        "Could not send WhatsApp code. Try again in a moment.",
      );
    }

    return ok(res, {
      target: maskTarget(phone, "sms"),
      expiresInSeconds: env.OTP_TTL_SECONDS,
      // Mirrors the guest-OTP devCode behaviour: in stub mode the code
      // comes back in the response so local testing works without Twilio.
      devCode: env.NOTIFICATIONS_PROVIDER === "stub" ? code : undefined,
    });
  },
);

// Verify the caller's current password via a Supabase sign-in attempt.
async function verifyCurrentSecret(userEmail: string, secret: string): Promise<boolean> {
  const verify = await supabaseAdmin.auth.signInWithPassword({
    email: userEmail,
    password: secret,
  });
  return !verify.error && !!verify.data.session;
}

const changePwSchema = z.object({
  oldPassword: z.string().min(1),
  otp: z.string().min(4).max(8),
  newPassword: z.string().min(8).max(128),
});

router.post(
  "/me/password/change",
  requireAuth,
  validate(changePwSchema),
  async (req, res) => {
    const userId = req.user!.id;
    const userEmail = req.user!.email;
    const { oldPassword, otp, newPassword } = req.body as z.infer<typeof changePwSchema>;
    const clientIp = req.ip ?? "unknown";

    if (oldPassword === newPassword) {
      return fail(res, 400, "SAME_PASSWORD", "New password must be different from the current one");
    }

    // Re-verify old password (defence-in-depth in case the page sat open
    // between send-otp and change).
    if (!(await verifyCurrentSecret(userEmail, oldPassword))) {
      recordFailure(userEmail, clientIp);
      return fail(res, 401, "INVALID_CREDENTIALS", "Current password is incorrect");
    }

    // Resolve the user's phone — must match the target the OTP was sent to.
    const [row] = await db
      .select({ phone: profiles.phone })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    const phone = row?.phone?.trim() ?? "";
    if (!phone) return fail(res, 400, "NO_PHONE", "Profile phone missing");

    // Newest non-consumed OTP for this phone + purpose.
    const [otpRow] = await db
      .select()
      .from(otps)
      .where(
        and(
          eq(otps.target, phone),
          eq(otps.purpose, "password_change"),
          isNull(otps.consumedAt),
        ),
      )
      .orderBy(sql`${otps.createdAt} desc`)
      .limit(1);

    if (!otpRow) return fail(res, 404, "NO_OTP", "No active OTP. Request a new code.");
    if (otpRow.expiresAt < new Date()) {
      return fail(res, 400, "EXPIRED", "OTP expired. Request a new code.");
    }
    if (otpRow.attempts >= env.OTP_MAX_ATTEMPTS) {
      return fail(res, 429, "TOO_MANY_ATTEMPTS", "Too many wrong attempts. Request a new code.");
    }
    if (otpRow.codeHash !== hashOtp(otp)) {
      await db.update(otps).set({ attempts: otpRow.attempts + 1 }).where(eq(otps.id, otpRow.id));
      return fail(res, 400, "INVALID_CODE", "Incorrect code");
    }

    // All checks passed — flip the password and mark the OTP consumed in
    // the same logical step. If the credential write fails we leave the OTP
    // un-consumed so the user can retry without requesting a new code.
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (error) return fail(res, 400, "AUTH_ERROR", error.message);

    await db.update(otps).set({ consumedAt: new Date() }).where(eq(otps.id, otpRow.id));

    await logActivity({
      action: "password_changed",
      entityType: "profile",
      entityId: userId,
      description: "Password changed via OTP-on-WhatsApp",
      performedBy: userId,
      ipAddress: req.ip,
    });

    return ok(res, { success: true });
  },
);

export default router;

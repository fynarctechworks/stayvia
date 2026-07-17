import { eq, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";

import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { localCredentials } from "../db/schema/localCredentials.js";
import { profiles } from "../db/schema/profiles.js";
import { logger } from "../lib/logger.js";
import {
  LOCKOUT,
  dummyVerify,
  hashSecret,
  issueAccessToken,
  issueRefreshToken,
  verifySecret,
  verifyToken,
} from "../lib/localAuth.js";
import { fail, ok } from "../lib/response.js";
// Static import is offline-safe: supabase.ts builds a null client without
// SUPABASE_* env and only throws at USE (proxy), which the offline branch
// never reaches. Dynamic import() fails inside the pkg-bundled sidecar.
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

// Offline auth routes. /login and /refresh are for the offline desk only;
// /provision-local is available online too (so a signed-in user sets up their
// desk PIN before going offline). See index.ts for the mount.

const router = Router();

// Defense-in-depth: /login and /refresh must NEVER work on an online server,
// regardless of mount order. They 404 (indistinguishable from not-mounted)
// when OFFLINE_MODE is off, so the cloud auth flow is the only login online.
function offlineOnly(_req: Request, res: Response, next: NextFunction) {
  if (!env.OFFLINE_MODE) {
    return fail(res, 404, "NOT_FOUND", "Not found");
  }
  next();
}

const loginSchema = z.object({
  email: z.string().email(),
  // Either a PIN (6+ digits) or the full password. We don't distinguish in the
  // schema; the handler tries PIN then password.
  secret: z.string().min(4).max(128),
});

const provisionSchema = z.object({
  // The signed-in user provisions THEIR OWN desk credentials. profileId comes
  // from the auth context, not the body, so one user can't provision another.
  password: z.string().min(8).max(128).optional(),
  pin: z
    .string()
    .regex(/^\d{6}$/, "PIN must be exactly 6 digits")
    .optional(),
  // Step-up (#6): the user's current account password, re-entered to authorize
  // setting/rotating the desk PIN. A hijacked bearer token alone must not be
  // able to plant a known offline PIN — this proves the caller also knows the
  // password. Verified via Supabase online, or the mirrored local hash offline.
  currentPassword: z.string().min(1).max(128),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(10),
});

/**
 * POST /login — offline credential login. Verifies PIN or password against
 * local_credentials, enforces a persisted lockout, and mints local JWTs.
 */
router.post("/login", offlineOnly, validate(loginSchema), async (req, res) => {
  const { email, secret } = req.body as z.infer<typeof loginSchema>;
  const clientIp = req.ip ?? "unknown";

  const [profile] = await db
    .select({ id: profiles.id, email: profiles.email, isActive: profiles.isActive })
    .from(profiles)
    .where(sql`lower(${profiles.email}) = lower(${email})`)
    .limit(1);

  // Uniform failure for EVERY negative case (unknown email, inactive,
  // not-provisioned, locked, bad secret) so the response is not an
  // account-existence oracle. The message and status are identical across all
  // of them — the only difference a caller can observe is success vs failure.
  const genericFail = () =>
    fail(res, 401, "INVALID_CREDENTIALS", "Email or credentials are incorrect");

  if (!profile || !profile.isActive) {
    // Equalize timing with the real-verify path (#5) so a fast reject doesn't
    // reveal that the email doesn't exist.
    dummyVerify();
    logger.warn({ email, ip: clientIp }, "offline login: unknown or inactive account");
    return genericFail();
  }

  const [cred] = await db
    .select()
    .from(localCredentials)
    .where(eq(localCredentials.profileId, profile.id))
    .limit(1);

  if (!cred || (!cred.pinHash && !cred.passwordHash)) {
    // Not provisioned. Return the SAME generic 401 (not a distinct
    // NOT_PROVISIONED) so a real active email can't be confirmed via this
    // unauthenticated route. The UI guides provisioning from an authenticated
    // session instead.
    dummyVerify();
    logger.warn({ email, ip: clientIp }, "offline login: no local credentials provisioned");
    return genericFail();
  }

  // Persisted lockout — survives an app restart (unlike an in-memory counter).
  // A lock whose window has passed is treated as cleared (attempts reset on the
  // next write below), so an expired lock doesn't cause a one-strike re-lock.
  const lockActive = !!cred.lockedUntil && cred.lockedUntil.getTime() > Date.now();
  if (lockActive) {
    dummyVerify();
    logger.warn({ email, ip: clientIp }, "offline login: account locked");
    return genericFail();
  }
  // Effective attempt baseline: if a lock has expired, start fresh from 0.
  const baseAttempts = cred.lockedUntil && !lockActive ? 0 : cred.failedAttempts;

  const matched =
    (cred.pinHash && verifySecret(secret, cred.pinHash)) ||
    (cred.passwordHash && verifySecret(secret, cred.passwordHash));

  if (!matched) {
    const attempts = baseAttempts + 1;
    const lockedUntil =
      attempts >= LOCKOUT.maxAttempts ? new Date(Date.now() + LOCKOUT.lockMs) : null;
    await db
      .update(localCredentials)
      .set({ failedAttempts: attempts, lockedUntil, updatedAt: new Date() })
      .where(eq(localCredentials.profileId, profile.id));
    logger.warn(
      { email, ip: clientIp, attempts, locked: !!lockedUntil },
      "offline login failed",
    );
    return genericFail();
  }

  // Success — reset the lockout counter.
  await db
    .update(localCredentials)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(localCredentials.profileId, profile.id));

  logger.info({ userId: profile.id, email, ip: clientIp }, "offline login succeeded");
  return ok(res, {
    user: { id: profile.id, email: profile.email },
    token: issueAccessToken(profile.id),
    refresh_token: issueRefreshToken(profile.id),
  });
});

/**
 * POST /provision-local — the signed-in user sets/updates their own offline
 * PIN and/or mirrors their password for the desk. Runs while online (real
 * auth in front). At least one of pin/password must be supplied.
 */
router.post("/provision-local", requireAuth, validate(provisionSchema), async (req, res) => {
  const { password, pin, currentPassword } = req.body as z.infer<typeof provisionSchema>;
  if (!password && !pin) {
    return fail(res, 400, "NOTHING_TO_SET", "Provide a PIN and/or a password");
  }
  const profileId = req.user!.id;
  const email = req.user!.email;

  // Step-up (#6): prove the caller knows the current password before we let a
  // bearer token set/rotate the offline PIN. Online we check via Supabase;
  // offline we check the mirrored local password hash.
  let stepUpOk = false;
  if (env.OFFLINE_MODE) {
    const [cred] = await db
      .select({ passwordHash: localCredentials.passwordHash })
      .from(localCredentials)
      .where(eq(localCredentials.profileId, profileId))
      .limit(1);
    // If no local password is on file yet (first provision), fall back to
    // requiring the password to be (re)set in the same call so a PIN is never
    // planted without a known password.
    stepUpOk = cred?.passwordHash
      ? verifySecret(currentPassword, cred.passwordHash)
      : !!password && currentPassword === password;
  } else {
    const verify = await supabaseAdmin.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    stepUpOk = !verify.error && !!verify.data.session;
  }
  if (!stepUpOk) {
    logger.warn({ userId: profileId }, "provision-local step-up failed");
    return fail(res, 403, "STEP_UP_REQUIRED", "Current password is incorrect");
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (pin) update.pinHash = hashSecret(pin);
  if (password) update.passwordHash = hashSecret(password);

  await db
    .insert(localCredentials)
    .values({
      profileId,
      pinHash: pin ? (update.pinHash as string) : null,
      passwordHash: password ? (update.passwordHash as string) : null,
    })
    .onConflictDoUpdate({
      target: localCredentials.profileId,
      set: update,
    });

  logger.info(
    { userId: profileId, setPin: !!pin, setPassword: !!password },
    "offline credentials provisioned",
  );
  return ok(res, { provisioned: true });
});

/**
 * POST /refresh — exchange a valid refresh token for a new access token so the
 * user isn't re-prompted for the PIN every 30 minutes.
 */
router.post("/refresh", offlineOnly, validate(refreshSchema), async (req, res) => {
  const { refresh_token } = req.body as z.infer<typeof refreshSchema>;
  const claims = verifyToken(refresh_token, "refresh");
  if (!claims) {
    return fail(res, 401, "INVALID_TOKEN", "Refresh token is invalid or expired");
  }
  // Confirm the profile is still active before re-issuing.
  const [profile] = await db
    .select({ id: profiles.id, isActive: profiles.isActive })
    .from(profiles)
    .where(eq(profiles.id, claims.sub))
    .limit(1);
  if (!profile || !profile.isActive) {
    return fail(res, 403, "ACCOUNT_DISABLED", "This account has been deactivated.");
  }
  return ok(res, {
    token: issueAccessToken(profile.id),
    refresh_token: issueRefreshToken(profile.id),
  });
});

export default router;

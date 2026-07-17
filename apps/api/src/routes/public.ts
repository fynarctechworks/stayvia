// Public (unauthenticated) surface. Today: hotel signup only.
//
// POST /public/signup — creates the Supabase auth user, then provisions the
// whole tenant in one DB transaction (property + settings + admin profile +
// role assignment + trialing subscription). The auth user is the only piece
// that can't join the transaction, so a failed transaction compensates by
// deleting it — no half-provisioned hotels, no orphaned logins.

import { signupSchema, type SignupInput } from "@stayvia/shared";
import { Router } from "express";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { subscriptions } from "../db/schema/subscriptions.js";
import { logger } from "../lib/logger.js";
import { provisionAdmin, provisionProperty } from "../lib/provisionProperty.js";
import { seedRbacCatalog } from "../lib/rbacCatalog.js";
import { fail, ok } from "../lib/response.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { signupLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

const router = Router();

router.post("/signup", signupLimiter, validate(signupSchema), async (req, res) => {
  const input = req.body as SignupInput;
  const clientIp = req.ip ?? "unknown";

  // 1. Supabase auth user. email_confirm skips the confirmation email —
  //    the owner signs in immediately after signup.
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });
  if (error || !data.user) {
    // Duplicate email → a deliberate, non-revealing 409. Supabase users
    // are platform-global, so a detailed message would confirm the email
    // belongs to some hotel's staff (cross-tenant enumeration).
    const code = (error as { code?: string } | null)?.code;
    if (code === "email_exists" || error?.message?.toLowerCase().includes("already")) {
      logger.warn({ ip: clientIp }, "signup rejected: email already registered");
      return fail(res, 409, "EMAIL_IN_USE", "This email cannot be used for signup");
    }
    logger.error({ ip: clientIp, reason: error?.message ?? "no user" }, "signup: createUser failed");
    return fail(res, 502, "AUTH_ERROR", "Could not create the account. Try again.");
  }
  const userId = data.user.id;

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

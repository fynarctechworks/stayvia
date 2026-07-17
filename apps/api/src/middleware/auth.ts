import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import type { Role } from "../db/schema/enums.js";
import { profiles } from "../db/schema/profiles.js";
import { logger } from "../lib/logger.js";
import { getUserPermissions, hasPermission } from "../lib/permission-resolver.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { fail } from "../lib/response.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: string;
      email: string;
      role: Role;
      fullName: string;
      permissions: Set<string>;
      isGodMode: boolean;
      rbacRoleKey: string | null;
    };
    // Tenant of the authenticated profile. Set by requireAuth (which 403s
    // when the profile has no hotel), so any handler behind requireAuth can
    // read it unconditionally. The tenant comes ONLY from the profile —
    // never from a client-supplied header.
    propertyId: string;
  }
}

// ---------------------------------------------------------------------------
// TEST-ONLY auth shim. When E2E_AUTH_SHIM=1 (and never in production —
// config/env.ts refuses to boot), the bearer token is verified LOCALLY as an
// HS256 JWT signed with SUPABASE_JWT_SECRET instead of a Supabase Auth
// round-trip. The e2e harness mints { sub: <profile uuid>, email } tokens
// with the same secret, so the suite runs against a throwaway stack with no
// GoTrue. Everything downstream of userId — profile lookup, tenancy, RBAC —
// is byte-for-byte the real path.
// ---------------------------------------------------------------------------
const E2E_AUTH_SHIM_ENABLED = env.E2E_AUTH_SHIM === "1" && env.NODE_ENV !== "production";

function fromBase64Url(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Returns the verified payload's sub, or null for anything malformed,
// mis-signed, or expired. Manual HMAC on purpose: no jose/jsonwebtoken dep.
function verifyShimToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", env.SUPABASE_JWT_SECRET)
    .update(`${head}.${body}`)
    .digest();
  const actual = fromBase64Url(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const header = JSON.parse(fromBase64Url(head).toString("utf8")) as { alg?: string };
    if (header.alg !== "HS256") return null;
    const payload = JSON.parse(fromBase64Url(body).toString("utf8")) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Already authenticated earlier in this request (the v1-level
  // subscription gate runs requireAuth before the routers do) — skip the
  // second Supabase round-trip; req.user/req.propertyId are stamped.
  if (req.user) return next();
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return fail(res, 401, "UNAUTHENTICATED", "Missing or malformed Authorization header");
  }
  const token = header.slice("Bearer ".length).trim();

  let userId: string;
  if (E2E_AUTH_SHIM_ENABLED) {
    const sub = verifyShimToken(token);
    if (!sub) {
      logger.warn(
        { ip: req.ip ?? "unknown", path: req.path, reason: "e2e_shim_rejected" },
        "auth failed: invalid token",
      );
      return fail(res, 401, "INVALID_TOKEN", "Token is invalid or expired");
    }
    userId = sub;
  } else {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      logger.warn(
        { ip: req.ip ?? "unknown", path: req.path, reason: error?.message ?? "no_user" },
        "auth failed: invalid token",
      );
      return fail(res, 401, "INVALID_TOKEN", "Token is invalid or expired");
    }
    userId = data.user.id;
  }

  const profile = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (profile.length === 0) {
    logger.warn(
      { userId, ip: req.ip ?? "unknown", path: req.path },
      "auth failed: no profile",
    );
    return fail(res, 403, "NO_PROFILE", "User has no associated profile");
  }
  if (!profile[0]!.isActive) {
    logger.warn(
      { userId: profile[0]!.id, ip: req.ip ?? "unknown", path: req.path },
      "auth failed: inactive user",
    );
    return fail(res, 403, "INACTIVE_USER", "Account is deactivated");
  }
  // A profile without a hotel is unusable in the SaaS — every query is
  // property-scoped. Shouldn't happen (provisioning stamps it), but if a
  // row slips through, refuse cleanly instead of leaking cross-tenant.
  if (!profile[0]!.propertyId) {
    logger.warn(
      { userId: profile[0]!.id, ip: req.ip ?? "unknown", path: req.path },
      "auth failed: profile has no property",
    );
    return fail(res, 403, "NO_PROPERTY", "Account is not linked to a hotel");
  }

  // Resolve effective RBAC permissions. Falls back gracefully if user_roles row is missing
  // (legacy users) — they'll get the empty set and only legacy requireRole checks pass.
  const perms = await getUserPermissions(profile[0]!.id);

  req.user = {
    id: profile[0]!.id,
    email: profile[0]!.email,
    role: profile[0]!.role,
    fullName: profile[0]!.fullName,
    permissions: perms.permissions,
    isGodMode: perms.isGodMode,
    rbacRoleKey: perms.roleKey,
  };
  req.propertyId = profile[0]!.propertyId;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return fail(res, 401, "UNAUTHENTICATED", "Not authenticated");
    if (!roles.includes(req.user.role)) {
      return fail(res, 403, "FORBIDDEN", `Requires role: ${roles.join(" or ")}`);
    }
    next();
  };
}

// Permission-based gate. Pass one or more permission keys; user must have at least one.
// Admin (god mode) always passes.
export function requirePermission(...keys: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return fail(res, 401, "UNAUTHENTICATED", "Not authenticated");
    const ok = keys.some((k) => hasPermission(req.user!, k));
    if (!ok) {
      // Privilege-escalation probe? Could be a staff member with the wrong
      // role, or someone forging requests with a stolen lesser-role token.
      // Either way it's worth surfacing in the log.
      logger.warn(
        {
          userId: req.user.id,
          role: req.user.role,
          required: keys,
          path: req.path,
          method: req.method,
          ip: req.ip ?? "unknown",
        },
        "permission denied",
      );
      return fail(
        res,
        403,
        "FORBIDDEN",
        `Requires permission: ${keys.join(" or ")}`,
      );
    }
    next();
  };
}

export const requireAdmin = requireRole("admin");

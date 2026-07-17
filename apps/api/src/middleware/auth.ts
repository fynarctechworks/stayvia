import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db } from "../db/client.js";
import { env } from "../config/env.js";
import type { Role } from "../db/schema/enums.js";
import { profiles } from "../db/schema/profiles.js";
import { logger } from "../lib/logger.js";
import { verifyToken } from "../lib/localAuth.js";
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
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return fail(res, 401, "UNAUTHENTICATED", "Missing or malformed Authorization header");
  }
  const token = header.slice("Bearer ".length).trim();

  // Resolve the authenticated user id. Offline desk verifies the token locally
  // against LOCAL_JWT_SECRET (no cloud round-trip); online delegates to
  // Supabase Auth exactly as before. Everything after this (profile load,
  // isActive check, permission resolution) is already fully local and shared.
  let userId: string;
  if (env.OFFLINE_MODE) {
    const claims = verifyToken(token, "access");
    if (!claims) {
      logger.warn(
        { ip: req.ip ?? "unknown", path: req.path },
        "auth failed: invalid local token",
      );
      return fail(res, 401, "INVALID_TOKEN", "Token is invalid or expired");
    }
    userId = claims.sub;
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
